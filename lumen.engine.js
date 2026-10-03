/*! ══════════════════════════════════════════════════════════════════════
    lumen.engine.js — LUMEN 实时渲染引擎
    延迟渲染 (MRT G-Buffer) + 解析式光线追踪 + TAA + Bloom + ACES
    ─────────────────────────────────────────────────────────────────────
    对外只暴露一个 LUMEN.create(options)，体验页与测试台共用同一套管线。
    无回读、无 2D 画布叠加、无画布混色，全部在 GPU 上完成。
    ══════════════════════════════════════════════════════════════════════ */
(function (root) {
"use strict";

/* ─────────────────────────── 预设 ─────────────────────────── */
const TIER_ORDER = ["feather", "elegant", "extreme", "melt", "inferno"];

const TIER_LABEL = {
  feather: "极轻",
  elegant: "优雅",
  extreme: "极限",
  melt:    "熔毁",
  inferno: "地狱"
};

const TIER_NOTE = {
  feather: "集显与笔记本也能跑满",
  elegant: "默认观感档，玻璃与反射完整",
  extreme: "三次弹射，逐光源阴影开始吃帧",
  melt:    "四次弹射 + 36 光源，显卡开始发声",
  inferno: "六次弹射 + 64 光源，并自动继续升温"
};

const TIERS = {
  /* 极轻：单次弹射、无阴影射线、关闭色散，只保留折射主体 */
  feather: { res:0.50, bounce:1, light:3,  shadow:0,  sph:16, inst:400,  taa:0.35, bloom:0.30, dof:0.00, disp:0, heat:false },
  /* 优雅：默认档。单次弹射 + 少量阴影，流畅且折射可辨 */
  elegant: { res:0.70, bounce:1, light:6,  shadow:3,  sph:32, inst:900,  taa:0.25, bloom:0.45, dof:0.30, disp:1, heat:false },
  /* 极限：三次弹射 + 逐光源阴影射线 */
  extreme: { res:1.00, bounce:3, light:18, shadow:10, sph:64, inst:2400, taa:0.16, bloom:0.70, dof:0.60, disp:1, heat:false },
  /* 熔毁：四次弹射 + 36 光源 */
  melt:    { res:1.20, bounce:4, light:36, shadow:24, sph:64, inst:3600, taa:0.13, bloom:0.90, dof:0.85, disp:1, heat:false },
  /* 地狱：六次弹射 + 64 光源 + 自动升温 */
  inferno: { res:1.35, bounce:6, light:64, shadow:48, sph:64, inst:4096, taa:0.10, bloom:1.10, dof:1.00, disp:1, heat:true  }
};

const BASE = {
  exposure: 0.92,
  bloomThreshold: 1.35,
  ca: 0.55,
  grain: 0.014,
  path: 0.0,
  followScroll: true,
  orbit: 1.0,
  pause: false
};

/* ═══════════════════════════ 着色器 ═══════════════════════════ */
const HDR_FS = `#version 300 es
precision highp float;
precision highp int;
uniform float uTime;
`;
const HDR_VS = `#version 300 es
precision highp float;
uniform float uTime;
`;

/* 公共：噪声 / 轨道 / 环境光。整体压暗，让折射与追踪成为画面主体 */
const LIB = `
const float PI = 3.14159265359;
const float FLOOR_Y = -1.55;

float hash11(float p){ p = fract(p*0.1031); p *= p+33.33; p *= p+p; return fract(p); }
vec3 hash31(float p){
  vec3 q = fract(vec3(p)*vec3(0.1031,0.1030,0.0973));
  q += dot(q, q.yzx+33.33);
  return fract((q.xxy+q.yzz)*q.zyx);
}
vec3 orbitOffset(float phase, float amp, float t){
  return vec3(sin(t*0.70+phase)*1.60,
              sin(t*0.90+phase*1.7)*0.70,
              cos(t*0.60+phase*1.30)*1.60) * amp;
}
float emisPulse(vec3 p){ return 1.5 + 0.9*sin(uTime*2.0 + p.y*3.0 + p.x*2.0); }

/* 环境：深空底色 + 一束冷白主光 + 三点冷色补光。刻意压暗。 */
vec3 envColor(vec3 d){
  float t = clamp(d.y*0.5+0.5, 0.0, 1.0);
  vec3 c = mix(vec3(0.0035,0.0045,0.0080), vec3(0.0260,0.0380,0.0680), pow(t, 0.95));
  c += vec3(1.00,0.90,0.74) * pow(max(dot(d, normalize(vec3( 0.45, 0.62,-0.55))),0.0), 340.0) * 5.0;
  c += vec3(0.16,0.38,0.95) * pow(max(dot(d, normalize(vec3(-0.65, 0.25, 0.55))),0.0),  6.0) * 0.30;
  c += vec3(0.95,0.14,0.55) * pow(max(dot(d, normalize(vec3( 0.72,-0.28, 0.45))),0.0),  9.0) * 0.20;
  c += vec3(0.24,0.95,0.80) * pow(max(dot(d, normalize(vec3(-0.30,-0.55,-0.75))),0.0), 11.0) * 0.14;
  return c;
}
`;

const CAM = `
uniform vec3  uCamPos;
uniform vec3  uCamFwd;
uniform vec3  uCamRight;
uniform vec3  uCamUp;
uniform float uTanHalf;
uniform float uAspect;
uniform float uNear;
uniform float uFar;

vec3 rayDir(vec2 uv){
  vec2 ndc = uv*2.0 - 1.0;
  return normalize(uCamFwd + uCamRight*(ndc.x*uAspect*uTanHalf) + uCamUp*(ndc.y*uTanHalf));
}
float linearDepth(float d){
  float z = d*2.0 - 1.0;
  return (2.0*uNear*uFar)/(uFar + uNear - z*(uFar - uNear));
}
vec3 worldFromUV(vec2 uv, float d){
  return uCamPos + rayDir(uv)*linearDepth(d);
}
vec2 projectPoint(vec3 P, vec3 cp, vec3 fw, vec3 rt, vec3 up, float th, float asp){
  vec3 d = P - cp;
  float z = max(dot(d, fw), 1e-4);
  vec2 q = vec2(dot(d, rt), dot(d, up))/(z*th);
  return vec2(q.x/asp, q.y)*0.5 + 0.5;
}
`;

const SCENE = `
uniform vec4 uSphBase[MAX_SPH];
uniform vec4 uSphInfo[MAX_SPH];
uniform vec4 uSphCol[MAX_SPH];
uniform vec4 uSphMat[MAX_SPH];
uniform int  uSphereCount;

vec4 spherePos(int i){
  vec4 b = uSphBase[i];
  vec4 n = uSphInfo[i];
  return vec4(b.xyz + orbitOffset(n.x, n.y, uTime), b.w);
}
struct Hit {
  float t; vec3 n; vec3 albedo; float rough; float metal; float emis; float mid;
};
Hit noHit(){
  Hit h;
  h.t = -1.0; h.n = vec3(0.0,1.0,0.0); h.albedo = vec3(0.0);
  h.rough = 1.0; h.metal = 0.0; h.emis = 0.0; h.mid = 0.0;
  return h;
}
Hit intersectScene(vec3 ro, vec3 rd){
  Hit h = noHit();
  float tmin = 1e9;

  /* 地面：近乎完美的暗镜，让被追踪到的反射清晰可读 */
  if (abs(rd.y) > 1e-5){
    float tp = (FLOOR_Y - ro.y)/rd.y;
    if (tp > 0.004 && tp < tmin){
      vec3 p = ro + rd*tp;
      if (abs(p.x) < 70.0 && abs(p.z) < 70.0){
        tmin = tp;
        float g = min(abs(fract(p.x*0.5)-0.5), abs(fract(p.z*0.5)-0.5));
        float line = 1.0 - smoothstep(0.004, 0.026, g);
        h.t = tp;
        h.n = vec3(0.0,1.0,0.0);
        h.albedo = mix(vec3(0.008,0.010,0.016), vec3(0.10,0.28,0.62), line*0.7);
        h.rough = mix(0.075, 0.025, line);
        h.metal = 0.92; h.emis = 0.0; h.mid = 4.0;
      }
    }
  }

  for (int i=0;i<MAX_SPH;i++){
    if (i >= uSphereCount) break;
    vec4 s = spherePos(i);
    vec3 oc = ro - s.xyz;
    float b = dot(oc, rd);
    float c = dot(oc, oc) - s.w*s.w;
    float ds = b*b - c;
    if (ds < 0.0) continue;
    float sq = sqrt(ds);
    float t0 = -b - sq;
    float t1 = -b + sq;
    float t = (t0 > 0.006) ? t0 : t1;
    if (t > 0.006 && t < tmin){
      tmin = t;
      vec3 p = ro + rd*t;
      vec3 n = normalize(p - s.xyz);
      if (dot(n, rd) > 0.0) n = -n;
      h.t = t; h.n = n;
      h.albedo = uSphCol[i].rgb;
      h.rough  = uSphCol[i].a;
      h.metal  = uSphMat[i].x;
      h.emis   = uSphMat[i].y;
      h.mid    = uSphMat[i].z;
    }
  }
  return h;
}
`;

const LIGHT = `
uniform vec4 uLightPos[MAX_LIGHT];
uniform vec4 uLightCol[MAX_LIGHT];
uniform int  uLightCount;
uniform int  uShadowLights;

float shadowRay(vec3 ro, vec3 rd, float tmax){
  float sh = 1.0;
  if (rd.y < -1e-4){
    float t = (FLOOR_Y - ro.y)/rd.y;
    if (t > 0.025 && t < tmax) sh = 0.0;
  }
  if (sh > 0.5){
    for (int i=0;i<MAX_SPH;i++){
      if (i >= uSphereCount) break;
      vec4 s = spherePos(i);
      vec3 oc = ro - s.xyz;
      float b = dot(oc, rd);
      float c = dot(oc,oc) - s.w*s.w;
      float h = b*b - c;
      if (h > 0.0){
        float sq = sqrt(h);
        float t0 = -b - sq;
        float t1 = -b + sq;
        float t = (t0 > 0.025) ? t0 : t1;
        if (t > 0.025 && t < tmax){ sh = 0.0; break; }
      }
    }
  }
  return sh;
}
vec3 F_Schlick(vec3 f0, float u){ float f = pow(1.0-u, 5.0); return f0 + (1.0-f0)*f; }
float D_GGX(float NoH, float a){ float a2 = a*a; float d = (NoH*a2 - NoH)*NoH + 1.0; return a2/(PI*d*d + 1e-7); }
float V_Smith(float NoV, float NoL, float a){
  float a2 = a*a;
  float gv = NoL*sqrt(NoV*NoV*(1.0-a2)+a2);
  float gl = NoV*sqrt(NoL*NoL*(1.0-a2)+a2);
  return 0.5/max(gv+gl, 1e-5);
}
vec3 directLight(vec3 P, vec3 N, vec3 V, vec3 albedo, float rough, float metal){
  vec3 f0 = mix(vec3(0.04), albedo, metal);
  vec3 diffC = albedo*(1.0-metal);
  vec3 col = vec3(0.0);
  for (int i=0;i<MAX_LIGHT;i++){
    if (i >= uLightCount) break;
    vec3 Lv = uLightPos[i].xyz - P;
    float dist = length(Lv);
    vec3 L = Lv/max(dist, 1e-4);
    float NoL = dot(N, L);
    if (NoL <= 0.0) continue;
    float att = uLightPos[i].w/(1.0 + dist*dist*0.32);
    vec3 rad = uLightCol[i].rgb * att;
    float sh = (i < uShadowLights) ? shadowRay(P + N*0.02, L, dist - 0.06) : 1.0;
    vec3 H = normalize(V + L);
    float NoV = max(dot(N,V), 1e-4);
    float NoH = max(dot(N,H), 0.0);
    float VoH = max(dot(V,H), 0.0);
    float a = max(rough*rough, 0.002);
    vec3 F = F_Schlick(f0, VoH);
    vec3 spec = vec3(D_GGX(NoH, a) * V_Smith(NoV, max(NoL,1e-4), a)) * F;
    col += (diffC*(1.0-F)/PI + spec) * rad * NoL * sh;
  }
  return col;
}
vec3 ambientLight(vec3 N, vec3 V, vec3 albedo, float rough, float metal){
  vec3 f0 = mix(vec3(0.04), albedo, metal);
  float NoV = max(dot(N,V), 1e-4);
  vec3 F = F_Schlick(f0, NoV);
  vec3 kd = (1.0-F)*(1.0-metal);
  vec3 R = reflect(-V, N);
  return kd*albedo*envColor(N)*0.85 + envColor(R)*F*(1.0 - rough*0.80);
}
`;

const VS_INST = HDR_VS + LIB + `
uniform mat4 uProj;
uniform mat4 uView;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec2 aUV;
layout(location=3) in vec4 iA;
layout(location=4) in vec4 iB;
layout(location=5) in vec4 iC;
layout(location=6) in vec4 iD;
layout(location=7) in vec4 iE;
out vec3 vW; out vec3 vN; out vec2 vUV; out vec4 vAlb; out vec4 vPar;

vec3 rotAxis(vec3 v, vec3 a, float ang){
  float c = cos(ang), s = sin(ang);
  return v*c + cross(a, v)*s + a*dot(a, v)*(1.0-c);
}
void main(){
  float ph = iD.w;
  vec3 off = iA.xyz + orbitOffset(ph, iE.x, uTime);
  vec3 axis = normalize(iB.xyz + vec3(1e-4));
  float ang = iB.w + uTime*iE.y;
  vec3 p = rotAxis(aPos*iA.w, axis, ang) + off;
  vec3 n = rotAxis(aNrm, axis, ang);
  vW = p; vN = n; vUV = aUV; vAlb = iC; vPar = iD;
  gl_Position = uProj * uView * vec4(p, 1.0);
}`;

const VS_PLANE = HDR_VS + `
uniform mat4 uProj;
uniform mat4 uView;
uniform vec4 uAlbedo;
uniform vec4 uParams;
layout(location=0) in vec3 aPos;
layout(location=1) in vec3 aNrm;
layout(location=2) in vec2 aUV;
out vec3 vW; out vec3 vN; out vec2 vUV; out vec4 vAlb; out vec4 vPar;
void main(){
  vW = aPos; vN = aNrm; vUV = aUV; vAlb = uAlbedo; vPar = uParams;
  gl_Position = uProj * uView * vec4(aPos, 1.0);
}`;

const FS_GBUF = HDR_FS + `
uniform vec3 uCamPos;
in vec3 vW; in vec3 vN; in vec2 vUV; in vec4 vAlb; in vec4 vPar;
layout(location=0) out vec4 gAlbedo;
layout(location=1) out vec4 gNormal;
layout(location=2) out vec4 gEmissive;

void main(){
  vec3 albedo = vAlb.rgb;
  float rough = clamp(vAlb.a, 0.02, 1.0);
  float metal = clamp(vPar.x, 0.0, 1.0);
  float emis  = vPar.y;
  float mid   = vPar.z;

  vec3 N = normalize(vN);
  vec3 V = normalize(uCamPos - vW);
  if (dot(N, V) < 0.0) N = -N;

  if (mid > 3.5){
    vec2 gp = vW.xz*0.5;
    vec2 g = abs(fract(gp) - 0.5) / max(fwidth(gp), vec2(1e-5));
    float line = 1.0 - min(min(g.x, g.y), 1.0);
    albedo = mix(albedo, vec3(0.10,0.28,0.62), line*0.75);
    rough  = mix(rough, 0.03, line);
  } else {
    float stripe = 0.5 + 0.5*sin(vUV.x*180.0 + vUV.y*40.0 + uTime*1.2);
    albedo *= mix(1.0, 0.90 + 0.10*stripe, 0.4*(1.0-rough));
  }

  gAlbedo   = vec4(albedo, rough);
  gNormal   = vec4(N*0.5 + 0.5, metal);
  gEmissive = vec4(albedo*emis, mid/8.0);
}`;

const FS_LIGHT = HDR_FS + CAM + LIB + SCENE + LIGHT + `
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uGA;
uniform sampler2D uGB;
uniform sampler2D uGC;
uniform sampler2D uDepth;

void main(){
  float d = texture(uDepth, vUV).r;
  vec3 rd = rayDir(vUV);
  if (d >= 0.999999){
    outColor = vec4(envColor(rd)*0.85, 1.0);
    return;
  }
  vec3 P = uCamPos + rd*linearDepth(d);
  vec4 gA = texture(uGA, vUV);
  vec4 gB = texture(uGB, vUV);
  vec4 gC = texture(uGC, vUV);

  vec3 N = normalize(gB.xyz*2.0 - 1.0);
  vec3 V = normalize(uCamPos - P);
  float rough = clamp(gA.a, 0.03, 1.0);
  float metal = gB.a;
  float mid   = gC.a*8.0;
  vec3 albedo = gA.rgb;
  vec3 emis   = gC.rgb;

  vec3 col = directLight(P, N, V, albedo, rough, metal);
  col += ambientLight(N, V, albedo, rough, metal);
  col += emis * emisPulse(P);

  /* 玻璃像素只留一层极暗的底，真正的颜色由光追通道覆盖 */
  if (mid > 1.5 && mid < 2.5) col *= 0.12;

  outColor = vec4(col, 1.0);
}`;

const FS_RT = HDR_FS + CAM + LIB + SCENE + LIGHT + `
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uScene;
uniform sampler2D uGA;
uniform sampler2D uGB;
uniform sampler2D uGC;
uniform sampler2D uDepth;
uniform int   uBounces;
uniform float uDispersion;
uniform vec3  uAbsorb;

vec3 shadeHit(vec3 P, vec3 N, vec3 rd, Hit h){
  vec3 V = -rd;
  vec3 col = directLight(P, N, V, h.albedo, h.rough, h.metal);
  col += ambientLight(N, V, h.albedo, h.rough, h.metal);
  col += h.albedo * h.emis * emisPulse(P);
  return col;
}
vec3 tracePath(vec3 ro, vec3 rd){
  vec3 acc = vec3(0.0);
  vec3 thr = vec3(1.0);
  for (int b=0;b<8;b++){
    if (b >= uBounces) break;
    Hit h = intersectScene(ro, rd);
    if (h.t < 0.0){ acc += thr*envColor(rd); break; }
    vec3 P = ro + rd*h.t;
    acc += thr * shadeHit(P, h.n, rd, h);
    if (h.mid > 1.5 && h.mid < 2.5){
      thr *= vec3(0.90);
    } else {
      float fres = pow(1.0 - max(dot(h.n, -rd), 0.0), 5.0);
      thr *= mix(h.albedo, vec3(1.0), h.metal) * (1.0 - h.rough*0.65) * (0.55 + 0.45*(1.0-fres));
    }
    vec3 jit = (hash31(float(b)*7.13 + uTime*0.37) - 0.5) * h.rough * 0.55;
    rd = normalize(reflect(rd, h.n) + jit);
    ro = P + h.n*0.02;
    if (max(thr.r, max(thr.g, thr.b)) < 0.02) break;
  }
  return acc;
}
vec3 glassPath(vec3 P, vec3 N, vec3 V, float ior){
  vec3 rd = refract(-V, N, 1.0/ior);
  if (dot(rd, rd) < 1e-6) return tracePath(P, reflect(-V, N));
  Hit h = intersectScene(P + rd*0.012, rd);
  if (h.t < 0.0) return envColor(rd);
  vec3 E = P + rd*(h.t + 0.012);
  vec3 rOut = refract(rd, h.n, ior);
  if (dot(rOut, rOut) < 1e-6) rOut = reflect(rd, h.n);
  vec3 tint = exp(-uAbsorb * (h.t*1.6));
  return tracePath(E, normalize(rOut)) * tint;
}
void main(){
  float d = texture(uDepth, vUV).r;
  vec3 lit = texture(uScene, vUV).rgb;
  if (d >= 0.999999){ outColor = vec4(lit, 1.0); return; }

  vec3 P = worldFromUV(vUV, d);
  vec4 gA = texture(uGA, vUV);
  vec4 gB = texture(uGB, vUV);
  vec4 gC = texture(uGC, vUV);
  vec3 N = normalize(gB.xyz*2.0 - 1.0);
  vec3 V = normalize(uCamPos - P);
  float rough = clamp(gA.a, 0.03, 1.0);
  float mid   = gC.a*8.0;
  vec3 col = lit;

  if (mid > 1.5 && mid < 2.5){
    vec3 glass;
    if (uDispersion > 0.5){
      /* 红绿蓝用三个略微不同的折射率分别追踪：真实色散 */
      glass.r = glassPath(P, N, V, 1.478).r;
      glass.g = glassPath(P, N, V, 1.455).g;
      glass.b = glassPath(P, N, V, 1.432).b;
    } else {
      glass = glassPath(P, N, V, 1.455);
    }
    vec3 refl = tracePath(P + N*0.02, reflect(-V, N));
    float NoV = max(dot(N, V), 1e-4);
    float F = 0.04 + 0.96*pow(1.0 - NoV, 5.0);
    col = mix(glass, refl, clamp(F, 0.04, 1.0));
  } else {
    float mask = clamp(mix(1.0 - rough*1.7, 1.0, gB.a), 0.0, 1.0);
    if (mask > 0.004){
      col = mix(col, tracePath(P + N*0.02, reflect(-V, N)), mask);
    }
  }
  outColor = vec4(col, 1.0);
}`;

const FS_TAA = HDR_FS + CAM + `
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uCur;
uniform sampler2D uHist;
uniform sampler2D uDepth;
uniform vec2  uRes;
uniform float uBlend;
uniform vec3  uPrevCamPos;
uniform vec3  uPrevCamFwd;
uniform vec3  uPrevCamRight;
uniform vec3  uPrevCamUp;

void main(){
  vec3 cur = texture(uCur, vUV).rgb;
  float d = texture(uDepth, vUV).r;
  if (d >= 0.999999 || uBlend >= 0.999){
    outColor = vec4(cur, 1.0);
    return;
  }
  vec3 P = worldFromUV(vUV, d);
  vec2 puv = projectPoint(P, uPrevCamPos, uPrevCamFwd, uPrevCamRight, uPrevCamUp, uTanHalf, uAspect);
  vec3 hist = texture(uHist, puv).rgb;

  vec3 mn = cur, mx = cur;
  for (int y=-1;y<=1;y++){
    for (int x=-1;x<=1;x++){
      vec3 c = texture(uCur, vUV + vec2(float(x), float(y))/uRes).rgb;
      mn = min(mn, c); mx = max(mx, c);
    }
  }
  hist = clamp(hist, mn, mx);
  float inside = (puv.x < 0.0 || puv.x > 1.0 || puv.y < 0.0 || puv.y > 1.0) ? 0.0 : 1.0;
  float k = mix(1.0, uBlend, inside);
  outColor = vec4(mix(hist, cur, k), 1.0);
}`;

const FS_DOWN = HDR_FS + `
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uSrc;
uniform vec2  uTexel;
uniform float uThreshold;
uniform float uFirst;

void main(){
  vec2 t = uTexel;
  vec3 a = texture(uSrc, vUV + t*vec2(-2.0, 2.0)).rgb;
  vec3 b = texture(uSrc, vUV + t*vec2( 0.0, 2.0)).rgb;
  vec3 c = texture(uSrc, vUV + t*vec2( 2.0, 2.0)).rgb;
  vec3 d = texture(uSrc, vUV + t*vec2(-2.0, 0.0)).rgb;
  vec3 e = texture(uSrc, vUV).rgb;
  vec3 f = texture(uSrc, vUV + t*vec2( 2.0, 0.0)).rgb;
  vec3 g = texture(uSrc, vUV + t*vec2(-2.0,-2.0)).rgb;
  vec3 h = texture(uSrc, vUV + t*vec2( 0.0,-2.0)).rgb;
  vec3 i = texture(uSrc, vUV + t*vec2( 2.0,-2.0)).rgb;
  vec3 j = texture(uSrc, vUV + t*vec2(-1.0, 1.0)).rgb;
  vec3 k = texture(uSrc, vUV + t*vec2( 1.0, 1.0)).rgb;
  vec3 l = texture(uSrc, vUV + t*vec2(-1.0,-1.0)).rgb;
  vec3 m = texture(uSrc, vUV + t*vec2( 1.0,-1.0)).rgb;

  vec3 o = e*0.125 + (a+c+g+i)*0.03125 + (b+d+f+h)*0.0625 + (j+k+l+m)*0.125;

  if (uFirst > 0.5){
    float br = max(o.r, max(o.g, o.b));
    float knee = max(uThreshold*0.6, 1e-4);
    float soft = clamp(br - uThreshold + knee, 0.0, 2.0*knee);
    soft = soft*soft/(4.0*knee + 1e-5);
    o *= max(soft, br - uThreshold)/max(br, 1e-5);
  }
  outColor = vec4(max(o, vec3(0.0)), 1.0);
}`;

const FS_UP = HDR_FS + `
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uSrc;
uniform vec2  uTexel;
uniform float uRadius;

void main(){
  vec2 t = uTexel*uRadius;
  vec3 o = vec3(0.0);
  o += texture(uSrc, vUV + t*vec2(-1.0,-1.0)).rgb * 1.0;
  o += texture(uSrc, vUV + t*vec2( 0.0,-1.0)).rgb * 2.0;
  o += texture(uSrc, vUV + t*vec2( 1.0,-1.0)).rgb * 1.0;
  o += texture(uSrc, vUV + t*vec2(-1.0, 0.0)).rgb * 2.0;
  o += texture(uSrc, vUV).rgb                    * 4.0;
  o += texture(uSrc, vUV + t*vec2( 1.0, 0.0)).rgb * 2.0;
  o += texture(uSrc, vUV + t*vec2(-1.0, 1.0)).rgb * 1.0;
  o += texture(uSrc, vUV + t*vec2( 0.0, 1.0)).rgb * 2.0;
  o += texture(uSrc, vUV + t*vec2( 1.0, 1.0)).rgb * 1.0;
  outColor = vec4(o/16.0, 1.0);
}`;

const FS_COMP = HDR_FS + `
in vec2 vUV;
out vec4 outColor;
uniform sampler2D uScene;
uniform sampler2D uBloom;
uniform vec2  uRes;
uniform float uBloomStr;
uniform float uExposure;
uniform float uCA;
uniform float uGrain;
uniform float uDof;

vec3 aces(vec3 x){
  return clamp((x*(2.51*x + 0.03))/(x*(2.43*x + 0.59) + 0.14), 0.0, 1.0);
}
void main(){
  vec2 dir = vUV - 0.5;
  vec3 c;
  if (uCA > 0.0001){
    c.r = texture(uScene, vUV + dir*uCA*0.0035).r;
    c.g = texture(uScene, vUV).g;
    c.b = texture(uScene, vUV - dir*uCA*0.0035).b;
  } else {
    c = texture(uScene, vUV).rgb;
  }

  if (uDof > 0.001){
    float coc = uDof * 0.020 * clamp(length(dir)*1.6, 0.0, 1.0);
    vec3 acc = c;
    float w = 1.0;
    for (int i=0;i<16;i++){
      float fi = float(i) + 0.5;
      float a = fi*2.399963;
      float r = sqrt(fi/16.0)*coc;
      vec2 uv = clamp(vUV + vec2(cos(a), sin(a))*r, vec2(0.001), vec2(0.999));
      acc += texture(uScene, uv).rgb;
      w += 1.0;
    }
    c = acc/w;
  }

  c += texture(uBloom, vUV).rgb * uBloomStr;
  c = aces(c * uExposure);

  /* 更重的暗角：把注意力压回画面中心的玻璃体 */
  float vig = 1.0 - smoothstep(0.20, 1.16, length(dir)*1.48);
  c *= mix(1.0, vig, 0.82);

  float g = fract(sin(dot(vUV*uRes, vec2(12.9898, 78.233)) + uTime*57.0)*43758.5453);
  c += (g - 0.5)*uGrain;

  outColor = vec4(pow(max(c, vec3(0.0)), vec3(1.0/2.2)), 1.0);
}`;

const VS_QUAD = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUV;
void main(){ vUV = aPos*0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`;

/* ═══════════════════════════ 相机路径 ═══════════════════════════ */
const CAM_KEYS = [
  { p:0.00, pos:[ 0.00, 0.85, 5.60], tgt:[0, 0.15, 0] },
  { p:0.22, pos:[ 2.90, 0.45, 3.40], tgt:[0, 0.05, 0] },
  { p:0.46, pos:[ 0.50, 0.34, 1.72], tgt:[0, 0.10, 0] },
  { p:0.68, pos:[-3.60, 2.40, 5.60], tgt:[0, 0.05, 0] },
  { p:0.86, pos:[ 0.00, 4.60, 7.20], tgt:[0, 0.00, 0] },
  { p:1.00, pos:[ 1.60, 1.20, 4.20], tgt:[0, 0.20, 0] }
];

const PASS_NAMES = ["gbuf", "light", "rt", "taa", "bloom", "comp"];

/* ═══════════════════════════ 工具 ═══════════════════════════ */
const nrm3 = v => { const l = Math.hypot(v[0],v[1],v[2]) || 1; return [v[0]/l, v[1]/l, v[2]/l]; };
const cross3 = (a,b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
const dot3 = (a,b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
const lerp = (a,b,t) => a + (b-a)*t;
const sstep = t => t*t*(3-2*t);

function uvSphere(seg, ring){
  const pos = [], nrm = [], uv = [], idx = [];
  for (let y = 0; y <= ring; y++){
    const v = y/ring, phi = v*Math.PI;
    for (let x = 0; x <= seg; x++){
      const u = x/seg, theta = u*Math.PI*2;
      const nx = Math.sin(phi)*Math.cos(theta);
      const ny = Math.cos(phi);
      const nz = Math.sin(phi)*Math.sin(theta);
      pos.push(nx, ny, nz); nrm.push(nx, ny, nz); uv.push(u, 1-v);
    }
  }
  for (let y = 0; y < ring; y++){
    for (let x = 0; x < seg; x++){
      const a = y*(seg+1) + x, b = a + seg + 1;
      idx.push(a, b, a+1, b, b+1, a+1);
    }
  }
  return { pos:new Float32Array(pos), nrm:new Float32Array(nrm),
           uv:new Float32Array(uv), idx:new Uint16Array(idx) };
}

/* ═══════════════════════════ create() ═══════════════════════════ */
function create(opts){
  opts = opts || {};
  const canvas = opts.canvas;
  if (!canvas) return { ok:false, reason:"no-canvas" };

  const gl = canvas.getContext("webgl2", {
    antialias:false, alpha:false, depth:false, stencil:false,
    premultipliedAlpha:false, preserveDrawingBuffer:false,
    powerPreference:"high-performance"
  });
  if (!gl) return { ok:false, reason:"no-webgl2", message:"此浏览器不支持 WebGL2。" };

  const onFrame = opts.onFrame || null;
  const errors = [];

  /* ── 能力探测 ── */
  const dbg = gl.getExtension("WEBGL_debug_renderer_info");
  const info = {
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : (gl.getParameter(gl.RENDERER) || "unknown"),
    vendor:   dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)   : (gl.getParameter(gl.VENDOR) || "unknown"),
    version:  gl.getParameter(gl.VERSION),
    maxUniformVectors: gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) || 256,
    maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    hasFloat: !!gl.getExtension("EXT_color_buffer_float"),
    hasTimer: false,
    maxSamples: gl.getParameter(gl.MAX_SAMPLES)
  };

  /* ── GPU 计时查询（真实每通道 GPU 耗时） ── */
  const timerExt = gl.getExtension("EXT_disjoint_timer_query_webgl2");
  info.hasTimer = !!timerExt;
  const pendingQueries = [];
  let queryActive = false;
  const gpuMs = {};
  PASS_NAMES.forEach(n => { gpuMs[n] = null; });

  function gpuBegin(name){
    if (!timerExt || queryActive) return;
    const q = gl.createQuery();
    gl.beginQuery(timerExt.TIME_ELAPSED_EXT, q);
    pendingQueries.push({ name, q });
    queryActive = true;
  }
  function gpuEnd(){
    if (!timerExt || !queryActive) return;
    gl.endQuery(timerExt.TIME_ELAPSED_EXT);
    queryActive = false;
  }
  function pollTimers(){
    if (!timerExt) return;
    if (gl.getParameter(timerExt.GPU_DISJOINT_EXT)){
      pendingQueries.forEach(p => gl.deleteQuery(p.q));
      pendingQueries.length = 0;
      return;
    }
    while (pendingQueries.length > 96){ gl.deleteQuery(pendingQueries.shift().q); }
    for (let i = pendingQueries.length - 1; i >= 0; i--){
      const p = pendingQueries[i];
      if (gl.getQueryParameter(p.q, gl.QUERY_RESULT_AVAILABLE)){
        const ms = gl.getQueryParameter(p.q, gl.QUERY_RESULT) / 1e6;
        gpuMs[p.name] = gpuMs[p.name] == null ? ms : gpuMs[p.name]*0.88 + ms*0.12;
        gl.deleteQuery(p.q);
        pendingQueries.splice(i, 1);
      }
    }
  }

  /* ── uniform 预算 → 决定 MAX_SPH / MAX_LIGHT ── */
  const budget = Math.max(60, Math.floor(info.maxUniformVectors*0.72) - 46);
  const n = Math.max(12, Math.floor(budget/6));
  const MAX_SPH = Math.min(64, n);
  const MAX_LIGHT = Math.min(64, n);

  const DEFINES = "#define MAX_SPH " + MAX_SPH + "\n#define MAX_LIGHT " + MAX_LIGHT + "\n";
  const D = s => s.replace(/^#version 300 es\n/, "#version 300 es\n" + DEFINES);

  /* ── 着色器编译 ── */
  function compile(type, src){
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)){
      const log = gl.getShaderInfoLog(s) || "";
      errors.push(log + "\n" + src.split("\n").map((l,i)=>(i+1)+"| "+l).slice(0,80).join("\n"));
      return null;
    }
    return s;
  }
  function program(vsSrc, fsSrc){
    const v = compile(gl.VERTEX_SHADER, vsSrc);
    const f = compile(gl.FRAGMENT_SHADER, fsSrc);
    if (!v || !f) return null;
    const p = gl.createProgram();
    gl.attachShader(p, v); gl.attachShader(p, f); gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)){
      errors.push("[链接失败] " + gl.getProgramInfoLog(p));
      return null;
    }
    gl.deleteShader(v); gl.deleteShader(f);
    const cache = {};
    const U = new Proxy(cache, {
      get(t, k){
        if (typeof k !== "string") return undefined;
        if (!(k in t)) t[k] = gl.getUniformLocation(p, k);
        return t[k];
      }
    });
    return { p, U };
  }

  const progInst  = program(VS_INST, FS_GBUF);
  const progPlane = program(VS_PLANE, FS_GBUF);
  const progLight = program(VS_QUAD, D(FS_LIGHT));
  const progRT    = program(VS_QUAD, D(FS_RT));
  const progTAA   = program(VS_QUAD, D(FS_TAA));
  const progDown  = program(VS_QUAD, D(FS_DOWN));
  const progUp    = program(VS_QUAD, D(FS_UP));
  const progComp  = program(VS_QUAD, D(FS_COMP));

  if (!progInst || !progPlane || !progLight || !progRT || !progTAA || !progDown || !progUp || !progComp){
    return { ok:false, reason:"shader", message:"渲染管线初始化失败。", errors, info };
  }

  const COL_FMT  = info.hasFloat ? gl.RGBA16F : gl.RGBA8;
  const COL_TYPE = info.hasFloat ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

  /* ── 配置 ── */
  const cfg = Object.assign({}, BASE, TIERS.elegant, { tier:"elegant" });
  cfg.sph = Math.min(cfg.sph, MAX_SPH);
  cfg.light = Math.min(cfg.light, MAX_LIGHT);
  cfg.shadow = Math.min(cfg.shadow, cfg.light);

  /* ── 资源 ── */
  let quadVAO = null, instVAO = null, instBuffers = [], INST_N = 0, instIndexCount = 0;
  let planeVAO = null;
  let sphBase = null, sphInfo = null, sphCol = null, sphMat = null;
  let lightPos = null, lightCol = null;
  let gbuf = null, sceneRT = null, rtRT = null, taaRT = [null, null], mips = [];
  let TAA_SRC = 0, PIXELS = 0, TAA_WARM = 0;
  let running = false, rafId = 0, elapsed = 0, frameCounter = 0, drawCalls = 0;
  let lastT = 0, heatTimer = 0, disposed = false;

  const PROJ = new Float32Array(16);
  const VIEW = new Float32Array(16);

  const cam = {
    pos:[0,0.85,5.6], tgt:[0,0.15,0], fov:42,
    fwd:[0,0,1], right:[1,0,0], up:[0,1,0], tanHalf:0.3839, aspect:1.6,
    prev:{ pos:[0,0.85,5.6], fwd:[0,0,1], right:[1,0,0], up:[0,1,0] },
    yaw:0, pitch:0
  };

  const stats = {
    fps: 0, ms: 16.7, gpuMs: null, passMs: gpuMs, passes: {},
    pixels: 0, drawCalls: 0, instances: 0, raysPerSec: 0,
    tier: "elegant", frame: 0,
    hist: new Float32Array(120), histIdx: 0
  };
  let fpsAcc = 0, fpsN = 0, hudT = 0;
  let pathOverride = null, ptrX = 0, ptrY = 0, tgtPX = 0, tgtPY = 0, scrollP = 0, smoothP = 0;

  /* ═══════════ 渲染目标 ═══════════ */
  function makeTarget(w, h, count, withDepth, filter){
    w = Math.max(2, w|0); h = Math.max(2, h|0);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    const texs = [], bufs = [];
    for (let i = 0; i < count; i++){
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, COL_FMT, w, h, 0, gl.RGBA, COL_TYPE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, t, 0);
      texs.push(t); bufs.push(gl.COLOR_ATTACHMENT0 + i);
    }
    gl.drawBuffers(bufs);
    let depthTex = null;
    if (withDepth){
      depthTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, depthTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.DEPTH_COMPONENT24, w, h, 0, gl.DEPTH_COMPONENT, gl.UNSIGNED_INT, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.TEXTURE_2D, depthTex, 0);
    }
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { fbo, texs, depthTex, w, h, ok };
  }
  function killTarget(t){
    if (!t) return;
    gl.deleteFramebuffer(t.fbo);
    t.texs.forEach(x => gl.deleteTexture(x));
    if (t.depthTex) gl.deleteTexture(t.depthTex);
  }
  function allocate(w, h){
    [gbuf, sceneRT, rtRT, taaRT[0], taaRT[1]].forEach(killTarget);
    mips.forEach(killTarget);
    mips = [];
    gbuf     = makeTarget(w, h, 3, true, gl.NEAREST);
    sceneRT  = makeTarget(w, h, 1, false, gl.LINEAR);
    rtRT     = makeTarget(w, h, 1, false, gl.LINEAR);
    taaRT[0] = makeTarget(w, h, 1, false, gl.LINEAR);
    taaRT[1] = makeTarget(w, h, 1, false, gl.LINEAR);
    let mw = w >> 1, mh = h >> 1;
    for (let i = 0; i < 6 && mw > 4 && mh > 4; i++){
      mips.push(makeTarget(mw, mh, 1, false, gl.LINEAR));
      mw >>= 1; mh >>= 1;
    }
    TAA_SRC = 0; TAA_WARM = 0;
    PIXELS = w*h;
    stats.pixels = PIXELS;
    if (!gbuf.ok || !sceneRT.ok || !rtRT.ok) errors.push("渲染目标创建不完整。");
  }

  function resize(){
    const dpr = Math.min(root.devicePixelRatio || 1, 1.6);
    let w = Math.floor(canvas.clientWidth * cfg.res * dpr);
    let h = Math.floor(canvas.clientHeight * cfg.res * dpr);
    const LIM = 9.5e6;
    if (w*h > LIM){ const k = Math.sqrt(LIM/(w*h)); w = Math.floor(w*k); h = Math.floor(h*k); }
    w = Math.max(64, w); h = Math.max(64, h);
    if (canvas.width === w && canvas.height === h) return false;
    canvas.width = w; canvas.height = h;
    allocate(w, h);
    return true;
  }

  /* ═══════════ 几何 ═══════════ */
  function buildQuad(){
    quadVAO = gl.createVertexArray();
    gl.bindVertexArray(quadVAO);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  function buildInstances(count){
    const geo = uvSphere(20, 14);
    if (instVAO) gl.deleteVertexArray(instVAO);
    instBuffers.forEach(b => gl.deleteBuffer(b));
    instBuffers = [];

    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    const pb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, pb); gl.bufferData(gl.ARRAY_BUFFER, geo.pos, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

    const nb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, nb); gl.bufferData(gl.ARRAY_BUFFER, geo.nrm, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

    const tb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, tb); gl.bufferData(gl.ARRAY_BUFFER, geo.uv, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 2, gl.FLOAT, false, 0, 0);

    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, geo.idx, gl.STATIC_DRAW);
    instBuffers.push(pb, nb, tb, ib);

    const data = new Float32Array(count*20);
    const sb = new Float32Array(MAX_SPH*4);
    const si = new Float32Array(MAX_SPH*4);
    const sc = new Float32Array(MAX_SPH*4);
    const sm = new Float32Array(MAX_SPH*4);

    let rnd = 1337;
    const R = () => (rnd = (rnd*1664525 + 1013904223) >>> 0) / 4294967296;

    for (let i = 0; i < count; i++){
      const o = i*20;
      let pos, scale, alb, rough, metal, emis, mid, phase, amp, spin, ax, an;

      if (i === 0){
        /* 主角：更大的液态玻璃球，画面重心 */
        pos   = [0, 0.14, 0];
        scale = 1.22;
        alb   = [0.94, 0.97, 1.00];
        rough = 0.030; metal = 0.0; emis = 0.0; mid = 2;
        phase = 0.0; amp = 0.0; spin = 0.06;
        ax = [0,1,0]; an = 0;
      } else if (i === 1){
        /* 副玻璃球：制造双层折射与互相映照 */
        pos   = [0.95, -0.30, 0.55];
        scale = 0.46;
        alb   = [0.92, 0.96, 1.00];
        rough = 0.025; metal = 0.0; emis = 0.0; mid = 2;
        phase = 1.7; amp = 0.30; spin = 0.22;
        ax = [0.3,1,0.2]; an = 0.4;
      } else {
        const r = 2.1 + R()*2.6;
        const th = R()*Math.PI*2;
        const ph2 = Math.acos(1 - 2*R());
        pos = [Math.sin(ph2)*Math.cos(th)*r, 0.60 + Math.cos(ph2)*1.00, Math.sin(ph2)*Math.sin(th)*r];
        scale = 0.030 + R()*0.120;
        phase = R()*6.283;
        amp   = 0.15 + R()*0.60;
        spin  = 0.25 + R()*1.6;
        ax = [R()*2-1, R()*2-1, R()*2-1]; an = R()*6.283;
        const roll = R();
        /* 以折射为主：玻璃 52% / 镜面铬 36% / 自发光 12% */
        if (roll < 0.52){
          alb = [0.90,0.95,1.00]; rough = 0.02 + R()*0.03; metal = 0.0; emis = 0.0; mid = 2;
        } else if (roll < 0.88){
          alb = [0.88,0.92,0.98]; rough = 0.04 + R()*0.09; metal = 1.0; emis = 0.0; mid = 1;
        } else {
          const h = R();
          alb = [1.0, 0.28 + h*0.6, 0.38 + (1-h)*0.5];
          rough = 0.22; metal = 0.0; emis = 1.6 + R()*2.2; mid = 3;
        }
      }

      data[o+0]=pos[0]; data[o+1]=pos[1]; data[o+2]=pos[2]; data[o+3]=scale;
      data[o+4]=ax[0];  data[o+5]=ax[1];  data[o+6]=ax[2];  data[o+7]=an;
      data[o+8]=alb[0]; data[o+9]=alb[1]; data[o+10]=alb[2];data[o+11]=rough;
      data[o+12]=metal; data[o+13]=emis;  data[o+14]=mid;   data[o+15]=phase;
      data[o+16]=amp;   data[o+17]=spin;  data[o+18]=R();   data[o+19]=0;

      if (i < MAX_SPH){
        sb[i*4+0]=pos[0]; sb[i*4+1]=pos[1]; sb[i*4+2]=pos[2]; sb[i*4+3]=scale;
        si[i*4+0]=phase;  si[i*4+1]=amp;    si[i*4+2]=spin;   si[i*4+3]=0;
        sc[i*4+0]=alb[0]; sc[i*4+1]=alb[1]; sc[i*4+2]=alb[2]; sc[i*4+3]=rough;
        sm[i*4+0]=metal;  sm[i*4+1]=emis;   sm[i*4+2]=mid;    sm[i*4+3]=0;
      }
    }

    const ibuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, ibuf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    instBuffers.push(ibuf);
    for (let k = 0; k < 5; k++){
      const loc = 3 + k;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 80, k*16);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);

    instVAO = vao; INST_N = count; instIndexCount = geo.idx.length;
    sphBase = sb; sphInfo = si; sphCol = sc; sphMat = sm;
    stats.instances = count;
  }

  function buildPlane(){
    const S = 70, y = -1.55;
    const pos = new Float32Array([-S,y,-S,  S,y,-S,  S,y,S,  -S,y,-S,  S,y,S,  -S,y,S]);
    const nrm = new Float32Array([0,1,0, 0,1,0, 0,1,0, 0,1,0, 0,1,0, 0,1,0]);
    const uv  = new Float32Array([0,0, 1,0, 1,1, 0,0, 1,1, 0,1]);
    planeVAO = gl.createVertexArray();
    gl.bindVertexArray(planeVAO);
    const pb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, pb); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);
    const nb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, nb); gl.bufferData(gl.ARRAY_BUFFER, nrm, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1,3,gl.FLOAT,false,0,0);
    const tb = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, tb); gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2,2,gl.FLOAT,false,0,0);
    gl.bindVertexArray(null);
  }

  /* ═══════════ 光源 ═══════════ */
  const LIGHT_TINT = [
    [1.00,0.96,0.90],[0.34,0.60,1.00],[1.00,0.24,0.68],[0.30,1.00,0.86],
    [0.62,0.42,1.00],[1.00,0.72,0.30],[0.40,1.00,0.50],[1.00,0.40,0.40]
  ];
  function allocLights(){
    lightPos = new Float32Array(MAX_LIGHT*4);
    lightCol = new Float32Array(MAX_LIGHT*4);
  }
  function updateLights(t, cnt){
    const P = lightPos, C = lightCol;
    const put = (i,x,y,z,rad,r,g,b) => {
      P[i*4]=x; P[i*4+1]=y; P[i*4+2]=z; P[i*4+3]=rad;
      C[i*4]=r; C[i*4+1]=g; C[i*4+2]=b; C[i*4+3]=0;
    };
    put(0,  5.0, 7.2,  4.2, 24.0, 1.00, 0.94, 0.86);
    if (cnt > 1) put(1, -6.4, 3.0,  2.4, 17.0, 0.28, 0.52, 1.00);
    if (cnt > 2) put(2,  0.0, 3.6, -7.4, 19.0, 1.00, 0.22, 0.64);
    for (let i = 3; i < cnt && i < MAX_LIGHT; i++){
      const k = i - 3;
      const a = t*(0.16 + (i%5)*0.05) + k*2.399;
      const rr = 3.0 + (i%4)*0.9;
      const c = LIGHT_TINT[i % LIGHT_TINT.length];
      put(i, Math.cos(a)*rr, 0.9 + Math.sin(t*0.6 + k)*1.5, Math.sin(a)*rr,
          5.5 + Math.sin(t*1.1 + k)*2.0, c[0], c[1], c[2]);
    }
  }

  /* ═══════════ 相机 ═══════════ */
  function camPath(p){
    if (p <= CAM_KEYS[0].p) return CAM_KEYS[0];
    for (let i = 1; i < CAM_KEYS.length; i++){
      if (p <= CAM_KEYS[i].p){
        const a = CAM_KEYS[i-1], b = CAM_KEYS[i];
        const t = sstep((p - a.p)/(b.p - a.p));
        return {
          pos:[lerp(a.pos[0],b.pos[0],t), lerp(a.pos[1],b.pos[1],t), lerp(a.pos[2],b.pos[2],t)],
          tgt:[lerp(a.tgt[0],b.tgt[0],t), lerp(a.tgt[1],b.tgt[1],t), lerp(a.tgt[2],b.tgt[2],t)]
        };
      }
    }
    return CAM_KEYS[CAM_KEYS.length-1];
  }

  function updateCamera(dt){
    cam.prev.pos = cam.pos.slice();
    cam.prev.fwd = cam.fwd.slice();
    cam.prev.right = cam.right.slice();
    cam.prev.up = cam.up.slice();

    if (cfg.followScroll && pathOverride == null){
      const denom = Math.max(1, (document.documentElement.scrollHeight - root.innerHeight));
      const raw = (root.scrollY || 0) / denom;
      scrollP = Math.max(0, Math.min(1, raw || 0));
    } else if (pathOverride != null){
      scrollP = Math.max(0, Math.min(1, pathOverride));
    }
    smoothP += (scrollP - smoothP) * (1 - Math.exp(-dt*5.0));
    ptrX += (tgtPX - ptrX) * (1 - Math.exp(-dt*5));
    ptrY += (tgtPY - ptrY) * (1 - Math.exp(-dt*5));

    const key = camPath(smoothP);
    const idle = elapsed*0.05*cfg.orbit;
    let px = key.pos[0], py = key.pos[1], pz = key.pos[2];
    const tx = key.tgt[0], ty = key.tgt[1], tz = key.tgt[2];

    const d = Math.hypot(px, pz);
    const a = Math.atan2(pz, px) + cam.yaw + Math.sin(idle*0.7)*0.03;
    px = Math.cos(a)*d; pz = Math.sin(a)*d;
    py += cam.pitch*2.2 + Math.sin(idle*0.9)*0.03;
    px += ptrX*0.45; py += ptrY*0.28;

    const k = 1 - Math.exp(-dt*4);
    cam.pos[0] += (px - cam.pos[0])*k;
    cam.pos[1] += (py - cam.pos[1])*k;
    cam.pos[2] += (pz - cam.pos[2])*k;
    cam.tgt[0] += (tx - cam.tgt[0])*k;
    cam.tgt[1] += (ty - cam.tgt[1])*k;
    cam.tgt[2] += (tz - cam.tgt[2])*k;

    const f = nrm3([cam.tgt[0]-cam.pos[0], cam.tgt[1]-cam.pos[1], cam.tgt[2]-cam.pos[2]]);
    const r = nrm3(cross3(f, [0,1,0]));
    const u = cross3(r, f);
    cam.fwd = f; cam.right = r; cam.up = u;
    cam.tanHalf = Math.tan(cam.fov*Math.PI/360);
    cam.aspect = canvas.clientWidth / Math.max(1, canvas.clientHeight);
  }

  function buildMatrices(){
    const n = 0.05, f = 200.0, th = cam.tanHalf, aspect = cam.aspect;
    PROJ.fill(0);
    PROJ[0] = 1/(aspect*th);
    PROJ[5] = 1/th;
    PROJ[10] = (f+n)/(n-f);
    PROJ[11] = -1;
    PROJ[14] = 2*f*n/(n-f);
    const e = cam.pos, r = cam.right, u = cam.up, fw = cam.fwd;
    VIEW[0]=r[0]; VIEW[1]=u[0]; VIEW[2]=-fw[0]; VIEW[3]=0;
    VIEW[4]=r[1]; VIEW[5]=u[1]; VIEW[6]=-fw[1]; VIEW[7]=0;
    VIEW[8]=r[2]; VIEW[9]=u[2]; VIEW[10]=-fw[2]; VIEW[11]=0;
    VIEW[12]=-dot3(r,e); VIEW[13]=-dot3(u,e); VIEW[14]=dot3(fw,e); VIEW[15]=1;
  }

  /* ═══════════ 渲染 ═══════════ */
  function bind(t){ gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null); }
  function viewport(t){
    if (t) gl.viewport(0, 0, t.w, t.h);
    else gl.viewport(0, 0, canvas.width, canvas.height);
  }
  function tex(unit, t, loc){
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.uniform1i(loc, unit);
  }
  function setCam(U){
    gl.uniform3fv(U.uCamPos, cam.pos);
    gl.uniform3fv(U.uCamFwd, cam.fwd);
    gl.uniform3fv(U.uCamRight, cam.right);
    gl.uniform3fv(U.uCamUp, cam.up);
    gl.uniform1f(U.uTanHalf, cam.tanHalf);
    gl.uniform1f(U.uAspect, cam.aspect);
    gl.uniform1f(U.uNear, 0.05);
    gl.uniform1f(U.uFar, 200.0);
  }
  function setSph(U, count){
    gl.uniform4fv(U.uSphBase, sphBase);
    gl.uniform4fv(U.uSphInfo, sphInfo);
    gl.uniform4fv(U.uSphCol, sphCol);
    gl.uniform4fv(U.uSphMat, sphMat);
    gl.uniform1i(U.uSphereCount, count);
  }

  function render(){
    drawCalls = 0;
    frameCounter++;
    const sphCount = Math.min(cfg.sph, INST_N, MAX_SPH);

    /* ── 1. G-Buffer ── */
    gpuBegin("gbuf");
    bind(gbuf); viewport(gbuf);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);

    gl.useProgram(progInst.p);
    gl.bindVertexArray(instVAO);
    gl.uniformMatrix4fv(progInst.U.uProj, false, PROJ);
    gl.uniformMatrix4fv(progInst.U.uView, false, VIEW);
    gl.uniform1f(progInst.U.uTime, elapsed);
    gl.drawElementsInstanced(gl.TRIANGLES, instIndexCount, gl.UNSIGNED_SHORT, 0, INST_N);
    drawCalls++;

    gl.useProgram(progPlane.p);
    gl.bindVertexArray(planeVAO);
    gl.uniformMatrix4fv(progPlane.U.uProj, false, PROJ);
    gl.uniformMatrix4fv(progPlane.U.uView, false, VIEW);
    gl.uniform1f(progPlane.U.uTime, elapsed);
    gl.uniform4f(progPlane.U.uAlbedo, 0.008, 0.010, 0.016, 0.075);
    gl.uniform4f(progPlane.U.uParams, 0.92, 0.0, 4.0, 0.0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    drawCalls++;
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
    gpuEnd();

    /* ── 2. 延迟 PBR ── */
    gpuBegin("light");
    bind(sceneRT); viewport(sceneRT);
    gl.useProgram(progLight.p);
    gl.bindVertexArray(quadVAO);
    tex(0, gbuf.texs[0], progLight.U.uGA);
    tex(1, gbuf.texs[1], progLight.U.uGB);
    tex(2, gbuf.texs[2], progLight.U.uGC);
    tex(3, gbuf.depthTex, progLight.U.uDepth);
    gl.uniform1f(progLight.U.uTime, elapsed);
    setCam(progLight.U);
    gl.uniform4fv(progLight.U.uLightPos, lightPos);
    gl.uniform4fv(progLight.U.uLightCol, lightCol);
    gl.uniform1i(progLight.U.uLightCount, Math.min(cfg.light, MAX_LIGHT));
    gl.uniform1i(progLight.U.uShadowLights, Math.min(cfg.shadow, cfg.light, MAX_LIGHT));
    setSph(progLight.U, sphCount);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    drawCalls++;
    gpuEnd();

    /* ── 3. 全屏光线追踪 ── */
    gpuBegin("rt");
    bind(rtRT); viewport(rtRT);
    gl.useProgram(progRT.p);
    tex(0, sceneRT.texs[0], progRT.U.uScene);
    tex(1, gbuf.texs[0], progRT.U.uGA);
    tex(2, gbuf.texs[1], progRT.U.uGB);
    tex(3, gbuf.texs[2], progRT.U.uGC);
    tex(4, gbuf.depthTex, progRT.U.uDepth);
    gl.uniform1f(progRT.U.uTime, elapsed);
    setCam(progRT.U);
    gl.uniform1i(progRT.U.uBounces, cfg.bounce);
    gl.uniform1f(progRT.U.uDispersion, cfg.disp);
    gl.uniform3f(progRT.U.uAbsorb, 0.60, 0.15, 0.32);
    gl.uniform4fv(progRT.U.uLightPos, lightPos);
    gl.uniform4fv(progRT.U.uLightCol, lightCol);
    gl.uniform1i(progRT.U.uLightCount, Math.min(cfg.light, MAX_LIGHT));
    gl.uniform1i(progRT.U.uShadowLights, Math.min(cfg.shadow, cfg.light, MAX_LIGHT));
    setSph(progRT.U, sphCount);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    drawCalls++;
    gpuEnd();

    /* ── 4. TAA ── */
    gpuBegin("taa");
    const dst = 1 - TAA_SRC;
    bind(taaRT[dst]); viewport(taaRT[dst]);
    gl.useProgram(progTAA.p);
    tex(0, rtRT.texs[0], progTAA.U.uCur);
    tex(1, taaRT[TAA_SRC].texs[0], progTAA.U.uHist);
    tex(2, gbuf.depthTex, progTAA.U.uDepth);
    gl.uniform1f(progTAA.U.uTime, elapsed);
    setCam(progTAA.U);
    gl.uniform2f(progTAA.U.uRes, taaRT[dst].w, taaRT[dst].h);
    gl.uniform1f(progTAA.U.uBlend, TAA_WARM < 4 ? 1.0 : cfg.taa);
    gl.uniform3fv(progTAA.U.uPrevCamPos, cam.prev.pos);
    gl.uniform3fv(progTAA.U.uPrevCamFwd, cam.prev.fwd);
    gl.uniform3fv(progTAA.U.uPrevCamRight, cam.prev.right);
    gl.uniform3fv(progTAA.U.uPrevCamUp, cam.prev.up);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    drawCalls++;
    TAA_SRC = dst; TAA_WARM++;
    const resolved = taaRT[TAA_SRC];
    gpuEnd();

    /* ── 5. Bloom 链 ── */
    gpuBegin("bloom");
    gl.useProgram(progDown.p);
    let srcT = resolved;
    for (let i = 0; i < mips.length; i++){
      bind(mips[i]); viewport(mips[i]);
      tex(0, srcT.texs[0], progDown.U.uSrc);
      gl.uniform2f(progDown.U.uTexel, 1/srcT.w, 1/srcT.h);
      gl.uniform1f(progDown.U.uThreshold, i === 0 ? cfg.bloomThreshold : 0.0);
      gl.uniform1f(progDown.U.uFirst, i === 0 ? 1.0 : 0.0);
      gl.uniform1f(progDown.U.uTime, elapsed);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      drawCalls++;
      srcT = mips[i];
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(progUp.p);
    for (let i = mips.length - 1; i > 0; i--){
      /* 目标里已存着降采样结果，这里只做加法叠加 */
      bind(mips[i-1]); viewport(mips[i-1]);
      tex(0, mips[i].texs[0], progUp.U.uSrc);
      gl.uniform2f(progUp.U.uTexel, 1/mips[i].w, 1/mips[i].h);
      gl.uniform1f(progUp.U.uRadius, 1.0);
      gl.uniform1f(progUp.U.uTime, elapsed);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      drawCalls++;
    }
    gl.disable(gl.BLEND);
    gpuEnd();

    /* ── 6. 合成 ── */
    gpuBegin("comp");
    bind(null); viewport(null);
    gl.useProgram(progComp.p);
    tex(0, resolved.texs[0], progComp.U.uScene);
    tex(1, mips.length ? mips[0].texs[0] : resolved.texs[0], progComp.U.uBloom);
    gl.uniform2f(progComp.U.uRes, canvas.width, canvas.height);
    gl.uniform1f(progComp.U.uBloomStr, cfg.bloom);
    gl.uniform1f(progComp.U.uExposure, cfg.exposure);
    gl.uniform1f(progComp.U.uCA, smoothP*1.4 + cfg.ca);
    gl.uniform1f(progComp.U.uGrain, cfg.grain);
    gl.uniform1f(progComp.U.uDof, cfg.dof);
    gl.uniform1f(progComp.U.uTime, elapsed);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    drawCalls++;
    gl.bindVertexArray(null);
    gpuEnd();

    stats.drawCalls = drawCalls;
  }

  /* ═══════════ 循环 ═══════════ */
  function loop(now){
    if (disposed) return;
    rafId = requestAnimationFrame(loop);
    if (cfg.pause){ lastT = now; return; }

    const dtRaw = (now - lastT)/1000;
    const dt = Math.min(0.06, Math.max(0.0005, dtRaw));
    lastT = now;
    elapsed += dt;

    stats.hist[stats.histIdx] = dtRaw*1000;
    stats.histIdx = (stats.histIdx + 1) % stats.hist.length;
    stats.frame++;

    resize();
    updateCamera(dt);
    updateLights(elapsed, Math.min(cfg.light, MAX_LIGHT));
    buildMatrices();
    render();
    pollTimers();

    fpsAcc += 1/Math.max(dtRaw, 1e-4); fpsN++;
    stats.ms = dtRaw*1000;
    stats.gpuMs = gpuMs;
    stats.passMs = gpuMs;
    stats.tier = cfg.tier;
    stats.frame = frameCounter;

    if (cfg.heat){
      heatTimer += dtRaw;
      if (heatTimer > 7){
        heatTimer = 0;
        cfg.bounce = Math.min(TIERS.inferno.bounce, cfg.bounce + 1);
        cfg.light  = Math.min(MAX_LIGHT, Math.round(cfg.light*1.25) + 1);
        cfg.shadow = Math.min(cfg.light, cfg.shadow + 2);
        cfg.sph    = Math.min(MAX_SPH, Math.round(cfg.sph*1.15) + 2);
        cfg.inst   = Math.min(4096, Math.round(cfg.inst*1.35) + 64);
        cfg.res    = Math.min(1.35, cfg.res + 0.06);
        buildInstances(cfg.inst);
        cfg.tier = "heat";
      }
    }

    if (now - hudT > 260){
      hudT = now;
      stats.fps = fpsAcc/Math.max(1, fpsN); fpsAcc = 0; fpsN = 0;
      const sph = Math.min(cfg.sph, INST_N, MAX_SPH);
      const rpp = cfg.bounce*(sph + Math.min(cfg.shadow, cfg.light)*sph) + Math.min(cfg.light, MAX_LIGHT)*sph;
      stats.raysPerSec = PIXELS * rpp * Math.max(stats.fps, 1);
    }
    if (onFrame) onFrame(stats);
  }

  /* ═══════════ 对外 API ═══════════ */
  const api = {
    ok: true, gl, info, cfg, stats, errors,
    maxSph: MAX_SPH, maxLight: MAX_LIGHT, tiers: TIERS, tierOrder: TIER_ORDER,

    start(){
      if (disposed || running) return;
      running = true;
      lastT = performance.now();
      rafId = requestAnimationFrame(loop);
    },
    stop(){
      running = false;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
    },
    dispose(){
      api.stop();
      disposed = true;
      [gbuf, sceneRT, rtRT, taaRT[0], taaRT[1]].forEach(killTarget);
      mips.forEach(killTarget);
      if (quadVAO) gl.deleteVertexArray(quadVAO);
      if (instVAO) gl.deleteVertexArray(instVAO);
      if (planeVAO) gl.deleteVertexArray(planeVAO);
      instBuffers.forEach(b => gl.deleteBuffer(b));
    },
    setTier(name){
      const p = TIERS[name];
      if (!p) return;
      Object.assign(cfg, p, { tier:name });
      cfg.light  = Math.min(cfg.light, MAX_LIGHT);
      cfg.shadow = Math.min(cfg.shadow, cfg.light);
      cfg.sph    = Math.min(cfg.sph, MAX_SPH);
      cfg.inst   = Math.max(16, Math.min(4096, cfg.inst|0));
      buildInstances(cfg.inst);
      resize();
      heatTimer = 0;
    },
    apply(patch){
      if (!patch) return;
      const needInst = patch.inst != null && patch.inst !== cfg.inst;
      Object.assign(cfg, patch);
      cfg.light  = Math.min(cfg.light, MAX_LIGHT);
      cfg.shadow = Math.min(cfg.shadow, Math.max(cfg.light, 0));
      cfg.sph    = Math.min(cfg.sph, MAX_SPH);
      if (needInst) buildInstances(Math.max(16, Math.min(4096, cfg.inst|0)));
      cfg.tier = "custom";
    },
    rebuild(){ buildInstances(Math.max(16, Math.min(4096, cfg.inst|0))); resize(); },
    pause(v){ cfg.pause = !!v; lastT = performance.now(); },
    setPath(p){ pathOverride = (p == null) ? null : p; },
    setPointer(nx, ny){ tgtPX = nx; tgtPY = ny; },
    orbit(dx, dy){
      cam.yaw += dx*0.004;
      cam.pitch = Math.max(-0.8, Math.min(0.8, cam.pitch + dy*0.002));
    },
    /* 供测试台读取：把最近 120 帧的帧时间拷出来 */
    frameTimes(out){
      const n = stats.hist.length;
      for (let i = 0; i < n; i++) out[i] = stats.hist[(stats.histIdx + i) % n];
      return out;
    },
    resetStats(){
      stats.hist.fill(0);
      stats.histIdx = 0;
      fpsAcc = 0; fpsN = 0; TAA_WARM = 0;
    }
  };

  buildQuad();
  allocLights();
  buildPlane();
  buildInstances(cfg.inst);
  updateCamera(1/60);
  buildMatrices();
  resize();

  return api;
}

root.LUMEN = {
  create,
  TIERS,
  TIER_ORDER,
  TIER_LABEL,
  TIER_NOTE,
  PASS_NAMES
};

})(typeof window !== "undefined" ? window : this);
