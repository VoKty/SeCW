/* ==========================================================================
   site.js — 交互层
   没有依赖、没有构建步骤，直接 file:// 打开也能跑。
   所有动效都尊重 prefers-reduced-motion。
   ========================================================================== */
(function () {
  "use strict";

  var root = document.documentElement;
  var reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var finePointer = window.matchMedia("(pointer: fine)").matches;

  /* ---------- 0. 开场动画 ---------- */
  /* 页面上有一段 .boot。整段动画靠 CSS 的延迟串起来（细线画圈 → 光点亮起 →
     细线展开 → 文字化开），这里只负责收尾和跳过，逻辑越少越好。
     点击、按键、滚轮、触摸都能立刻跳过；这个会话内只播一次。 */

  var boot = document.getElementById("boot");
  var booting = root.classList.contains("is-booting");

  if (boot) {
    if (!booting) {
      /* 这一轮不播：它本来就没显示，直接从 DOM 里丢掉 */
      boot.remove();
    } else {
      var finishIntro = function () {
        if (boot.dataset.done) return;
        boot.dataset.done = "1";
        window.clearTimeout(bootTimer);
        /* 先挂 is-done 再摘 is-booting，否则覆盖层会被立刻隐藏，看不到化开的过程 */
        boot.classList.add("is-done");
        root.classList.remove("is-booting");
        try { sessionStorage.setItem("blog.booted", "1"); } catch (e) { /* 忽略 */ }
        window.setTimeout(function () { boot.remove(); }, 1250);
      };

      var bootTimer = window.setTimeout(finishIntro, 3300);
      ["click", "keydown", "wheel", "touchstart"].forEach(function (type) {
        window.addEventListener(
          type,
          function () {
            window.clearTimeout(bootTimer);
            finishIntro();
          },
          { once: true, passive: true }
        );
      });
    }
  }

  /* ---------- 1. 主题 ---------- */
  var THEME_KEY = "blog.theme";
  var toggle = document.querySelector("[data-theme-toggle]");

  function readTheme() {
    try {
      var saved = localStorage.getItem(THEME_KEY);
      if (saved === "light" || saved === "dark") return saved;
    } catch (e) { /* 隐私模式下 localStorage 可能不可用 */ }
    return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  }

  function applyTheme(theme, animate) {
    var paint = function () {
      root.setAttribute("data-theme", theme);
      if (toggle) {
        toggle.setAttribute(
          "aria-label",
          theme === "light" ? "切换到深色模式" : "切换到浅色模式"
        );
      }
    };
    if (animate && document.startViewTransition && !reduceMotion) {
      document.startViewTransition(paint);
    } else {
      paint();
    }
  }

  applyTheme(readTheme(), false);

  if (toggle) {
    toggle.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "light" ? "dark" : "light";
      applyTheme(next, true);
      try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* 忽略 */ }
    });
  }

  /* ---------- 2. 顶栏与移动导航 ---------- */

  var header = document.querySelector(".header");
  var nav = document.querySelector("[data-nav]");
  var navToggle = document.querySelector("[data-nav-toggle]");

  if (navToggle && nav) {
    navToggle.addEventListener("click", function () {
      var open = nav.classList.toggle("is-open");
      navToggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    nav.addEventListener("click", function (event) {
      if (event.target.closest("a")) {
        nav.classList.remove("is-open");
        navToggle.setAttribute("aria-expanded", "false");
      }
    });
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && nav.classList.contains("is-open")) {
        nav.classList.remove("is-open");
        navToggle.setAttribute("aria-expanded", "false");
        navToggle.focus();
      }
    });
  }

  /* ---------- 3. 入场：错峰显现 ---------- */

  /* 动画跑完之后摘掉 animation，把 transform 交还给 [data-tilt] 之类的交互 */
  Array.prototype.forEach.call(document.querySelectorAll("[data-intro]"), function (el) {
    el.addEventListener("animationend", function (event) {
      if (event.animationName === "intro-in") el.classList.add("is-ready");
    });
  });

  var revealTargets = Array.prototype.slice.call(document.querySelectorAll("[data-reveal]"));

  if (!("IntersectionObserver" in window) || reduceMotion) {
    revealTargets.forEach(function (el) { el.classList.add("is-in"); });
  } else {
    var revealObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-in");
          revealObserver.unobserve(entry.target);
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
    );
    revealTargets.forEach(function (el) { revealObserver.observe(el); });
  }

  /* 给同组元素自动排延迟：越靠下越晚，但差距很小，避免"排队动画"感 */
  Array.prototype.forEach.call(document.querySelectorAll("[data-stagger]"), function (group) {
    var step = parseInt(group.getAttribute("data-stagger"), 10) || 60;
    Array.prototype.forEach.call(group.children, function (child, i) {
      if (!child.hasAttribute("data-reveal")) child.setAttribute("data-reveal", "");
      child.style.setProperty("--reveal-delay", Math.min(i * step, 420) + "ms");
    });
    if (!("IntersectionObserver" in window) || reduceMotion) {
      Array.prototype.forEach.call(group.children, function (child) { child.classList.add("is-in"); });
    } else {
      Array.prototype.forEach.call(group.children, function (child) { revealObserver.observe(child); });
    }
  });

  /* ---------- 4. 顶栏滚动态 + 阅读进度 ---------- */

  var progress = document.querySelector("[data-progress]");
  var ticking = false;

  function onScroll() {
    var y = window.scrollY || window.pageYOffset;
    if (header) header.classList.toggle("is-stuck", y > 8);
    if (progress) {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      var ratio = max > 0 ? Math.min(y / max, 1) : 0;
      progress.style.transform = "scaleX(" + ratio + ")";
      progress.classList.toggle("is-on", y > 120);
    }
    ticking = false;
  }

  window.addEventListener(
    "scroll",
    function () {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(onScroll);
    },
    { passive: true }
  );
  onScroll();

  /* ---------- 5. 光标柔光：非线性跟随 ---------- */

  var glow = document.querySelector("[data-glow]");
  if (glow && finePointer && !reduceMotion) {
    var target = { x: window.innerWidth / 2, y: window.innerHeight * 0.35 };
    var current = { x: target.x, y: target.y };
    var shown = false;

    window.addEventListener(
      "pointermove",
      function (event) {
        target.x = event.clientX;
        target.y = event.clientY;
        if (!shown) {
          shown = true;
          current.x = target.x;
          current.y = target.y;
          glow.classList.add("is-on");
        }
      },
      { passive: true }
    );

    window.addEventListener("pointerleave", function () { glow.classList.remove("is-on"); });

    (function loop() {
      /* 指数插值 = 越接近越慢，观感上就是"有重量" */
      current.x += (target.x - current.x) * 0.075;
      current.y += (target.y - current.y) * 0.075;
      glow.style.transform =
        "translate3d(" + current.x.toFixed(2) + "px," + current.y.toFixed(2) + "px,0)";
      window.requestAnimationFrame(loop);
    })();
  }

  /* ---------- 6. 轻微倾斜（只给静态卡片用） ---------- */

  if (finePointer && !reduceMotion) {
    Array.prototype.forEach.call(document.querySelectorAll("[data-tilt]"), function (el) {
      var rect = null;
      el.addEventListener("pointerenter", function () { rect = el.getBoundingClientRect(); });
      el.addEventListener(
        "pointermove",
        function (event) {
          if (!rect) rect = el.getBoundingClientRect();
          var px = (event.clientX - rect.left) / rect.width - 0.5;
          var py = (event.clientY - rect.top) / rect.height - 0.5;
          el.style.transform =
            "perspective(900px) rotateX(" + (-py * 4).toFixed(2) + "deg) rotateY(" +
            (px * 5).toFixed(2) + "deg) translateY(-2px)";
        },
        { passive: true }
      );
      el.addEventListener("pointerleave", function () { el.style.transform = ""; });
    });
  }

  /* ---------- 7. 本地时间（状态面板） ---------- */

  var clock = document.querySelector("[data-clock]");
  if (clock) {
    var render = function () {
      var now = new Date();
      var pad = function (n) { return n < 10 ? "0" + n : String(n); };
      clock.textContent = pad(now.getHours()) + ":" + pad(now.getMinutes());
    };
    render();
    window.setInterval(render, 20000);
  }

  /* ---------- 8. 页脚年份 ---------- */

  Array.prototype.forEach.call(document.querySelectorAll("[data-year]"), function (el) {
    el.textContent = String(new Date().getFullYear());
  });

  /* ---------- 9. 摄影筛选 ---------- */

  var shotGrid = document.querySelector("[data-shot-grid]");
  if (shotGrid) {
    var shots = Array.prototype.slice.call(shotGrid.querySelectorAll(".shot"));
    var chipGroups = Array.prototype.slice.call(document.querySelectorAll("[data-filter-group]"));
    var counter = document.querySelector("[data-shot-count]");
    var empty = document.querySelector("[data-shot-empty]");

    var active = {};
    chipGroups.forEach(function (group) {
      active[group.getAttribute("data-filter-group")] = "all";
    });

    var apply = function () {
      var visible = 0;
      shots.forEach(function (shot) {
        var ok = Object.keys(active).every(function (key) {
          var want = active[key];
          return want === "all" || shot.getAttribute("data-" + key) === want;
        });
        shot.classList.toggle("is-hidden", !ok);
        if (ok) visible += 1;
      });
      if (counter) counter.textContent = String(visible);
      if (empty) empty.hidden = visible !== 0;
      /* 重新触发一次淡入，让筛选结果有反馈 */
      if (!reduceMotion) {
        shots.forEach(function (shot) {
          if (shot.classList.contains("is-hidden")) return;
          shot.classList.remove("is-anim");
          void shot.offsetWidth;
          shot.classList.add("is-anim");
        });
      }
    };

    chipGroups.forEach(function (group) {
      var key = group.getAttribute("data-filter-group");
      group.addEventListener("click", function (event) {
        var chip = event.target.closest(".chip");
        if (!chip) return;
        active[key] = chip.getAttribute("data-value");
        Array.prototype.forEach.call(group.querySelectorAll(".chip"), function (c) {
          c.setAttribute("aria-pressed", c === chip ? "true" : "false");
        });
        apply();
      });
    });

    if (shots.length) apply();
  }

  /* ---------- 10. 灯箱 ---------- */

  var lightbox = document.querySelector("[data-lightbox]");
  if (lightbox) {
    var lbImg = lightbox.querySelector("[data-lb-img]");
    var lbCap = lightbox.querySelector("[data-lb-caption]");
    var lbExif = lightbox.querySelector("[data-lb-exif]");
    var lbTitle = lightbox.querySelector("[data-lb-title]");
    var lbIndex = lightbox.querySelector("[data-lb-index]");
    var list = Array.prototype.slice.call(document.querySelectorAll(".shot"));
    var cursor = 0;
    var lastFocus = null;
    /* 灯箱打开时把页面主体设为 inert：键盘和读屏都出不去，天然形成焦点限制 */
    var inertTargets = Array.prototype.slice.call(
      document.querySelectorAll("header.header, main, footer.footer")
    );

    var EXIF_FIELDS = [
      ["camera", "机身"],
      ["lens", "镜头"],
      ["focal", "焦段"],
      ["aperture", "光圈"],
      ["shutter", "快门"],
      ["iso", "ISO"],
      ["date", "拍摄时间"],
      ["place", "地点"]
    ];

    /* data-camera 用的是筛选用的小写标识，展示时要换成人能读的名字 */
    var CAMERA_LABEL = {
      "1dx": "Canon EOS-1D X",
      "g7": "Panasonic Lumix G7",
      "action4": "DJI Osmo Action 4"
    };

    var fill = function (shot) {
      var img = shot.querySelector("img");
      if (!img) return;
      lbImg.src = img.getAttribute("src");
      lbImg.alt = img.getAttribute("alt") || "";
      if (lbTitle) lbTitle.textContent = shot.getAttribute("data-title") || "";
      if (lbCap) lbCap.textContent = shot.getAttribute("data-note") || "";
      if (lbExif) {
        lbExif.innerHTML = "";
        EXIF_FIELDS.forEach(function (pair) {
          var value = shot.getAttribute("data-" + pair[0]);
          if (!value) return;
          if (pair[0] === "camera") value = CAMERA_LABEL[value] || value;
          var row = document.createElement("div");
          row.className = "kv__row";
          var k = document.createElement("div");
          k.className = "kv__k";
          k.textContent = pair[1];
          var v = document.createElement("div");
          v.className = "kv__v";
          v.textContent = value;
          row.appendChild(k);
          row.appendChild(v);
          lbExif.appendChild(row);
        });
      }
      if (lbIndex) lbIndex.textContent = String(cursor + 1) + " / " + String(list.length);
    };

    var open = function (shot) {
      cursor = list.indexOf(shot);
      if (cursor < 0) cursor = 0;
      lastFocus = document.activeElement;
      fill(list[cursor]);
      lightbox.classList.add("is-open");
      lightbox.setAttribute("aria-hidden", "false");
      document.body.style.overflow = "hidden";
      inertTargets.forEach(function (el) { el.inert = true; });
      var closeBtn = lightbox.querySelector("[data-lb-close]");
      if (closeBtn) closeBtn.focus();
    };

    var close = function () {
      lightbox.classList.remove("is-open");
      lightbox.setAttribute("aria-hidden", "true");
      document.body.style.overflow = "";
      inertTargets.forEach(function (el) { el.inert = false; });
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    };

    var step = function (delta) {
      if (!list.length) return;
      cursor = (cursor + delta + list.length) % list.length;
      fill(list[cursor]);
    };

    list.forEach(function (shot) {
      shot.addEventListener("click", function () { open(shot); });
    });

    lightbox.addEventListener("click", function (event) {
      if (event.target.closest("[data-lb-close]")) return close();
      if (event.target.closest("[data-lb-prev]")) return step(-1);
      if (event.target.closest("[data-lb-next]")) return step(1);
      /* 点击舞台空白处关闭，点击图片和侧栏不关 */
      if (event.target === lightbox || event.target.classList.contains("lightbox__stage")) close();
    });

    document.addEventListener("keydown", function (event) {
      if (!lightbox.classList.contains("is-open")) return;
      if (event.key === "Escape") close();
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
    });
  }

  /* ---------- 11. 目录高亮 ---------- */

  var tocLinks = Array.prototype.slice.call(document.querySelectorAll("[data-toc] a"));
  if (tocLinks.length && "IntersectionObserver" in window) {
    var linkFor = {};
    var headings = [];
    tocLinks.forEach(function (link) {
      var id = link.getAttribute("href").slice(1);
      var heading = document.getElementById(id);
      if (!heading) return;
      linkFor[id] = link;
      headings.push(heading);
    });

    var spy = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          var link = linkFor[entry.target.id];
          if (!link) return;
          if (entry.isIntersecting) {
            tocLinks.forEach(function (l) { l.classList.remove("is-active"); });
            link.classList.add("is-active");
          }
        });
      },
      { rootMargin: "-20% 0px -70% 0px", threshold: 0 }
    );
    headings.forEach(function (h) { spy.observe(h); });
  }

  /* ---------- 12. 文章底部：年份 + 返回顶部 ---------- */

  var toTop = document.querySelector("[data-to-top]");
  if (toTop) {
    toTop.addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
    });
  }
})();
