# 未完之章

一个高中生的个人博客：摄影、装备、技术折腾、AI、生活和关于我。

名字叫「未完之章」——于此记录，与世界相见。

纯静态站点 —— 手写 HTML / CSS / JavaScript，**没有框架、没有构建步骤、没有外部依赖**。
双击 `index.html` 就能打开，直接丢到任何静态托管上也能跑。

## 页面结构

| 文件 | 内容 |
| --- | --- |
| `index.html` | 首页：个人简介、最近更新、摄影预览、现在在折腾、装备概览 |
| `photography.html` | 摄影作品：按机身 / 题材筛选，点开有大图与 EXIF 参数 |
| `gear.html` | 装备：为什么买、用起来怎么样、缺点、现在还值不值得买 |
| `tech.html` | 技术：文章列表、实验日志、常用技术栈 |
| `ai.html` | AI：本地模型实测表、真实在用的场景、不用的场景 |
| `life.html` | 生活：随手记、普通的一天、学习方式 |
| `about.html` | 关于：基本资料、关键词、我在想的问题、折腾史 |
| `posts/*.html` | 文章详情页（带目录与阅读进度） |

```
assets/
  css/site.css      设计系统：颜色令牌、玻璃组件、动效、响应式、无障碍降级
  css/pages.css     页面级组件：首屏、摄影网格与灯箱、装备条目、文章排版
  js/site.js        主题切换、错峰入场、筛选、灯箱、目录高亮、光标柔光
  img/*.svg         照片占位图与设备示意图
```

## 怎么把占位图换成真实照片

站内所有照片目前都是手绘 SVG 占位图（`assets/img/ph-*.svg`），
换成自己的照片有两种做法：

**方法一：直接替换文件（最简单）**

保留文件名，把自己的照片改成同名文件放进 `assets/img/`。
浏览器不关心扩展名，但为了干净，建议同时把 HTML 里的 `src="...svg"` 改成 `.jpg`。

**方法二：新增照片并改 HTML（推荐）**

1. 把照片放进 `assets/img/photos/`
2. 在 `photography.html` 里复制一个 `<button class="shot" ...>` 区块，改这几处：
   - `src` / `alt` / `width` / `height`（写上真实宽高，避免布局跳动）
   - `data-camera`：`1dx` / `g7` / `action4`
   - `data-topic`：`landscape` / `city` / `campus` / `sport` / `daily` / `still`
   - `data-title` / `data-note` / `data-lens` / `data-focal` / `data-aperture` / `data-shutter` / `data-iso` / `data-date` / `data-place`
3. 首页的摄影预览用的是同样结构，只是外面套了 `<a>` 而不是 `<button>`

设备示意图（`assets/img/gear-*.svg`）是蓝图风格的矢量插画，
如果想换成实物照片，直接把 `gear.html` 里的 `<figure class="gear-figure">` 中的 `src` 换掉即可。

## 设计说明

- **玻璃**：`backdrop-filter` + 很低的 alpha（`rgba(255,255,255,.045)` 左右），靠模糊而不是靠白色堆出质感
- **光效**：三个低透明度色斑缓慢漂移（暖橙 / 冷青 / 淡紫），不用满屏渐变
- **动效**：统一用非线性缓动（`cubic-bezier(.16,1,.3,1)` 与带回弹的 `spring`），
  入场动效错峰出现，鼠标柔光用指数插值跟随
- **主题**：深色 / 浅色两套，默认跟随系统，手动切换后写入 `localStorage`
- **开场动画**：只在首页播放 —— 一圈细线画出的光圈、一条从中间展开的细线、一行字，最后整体化开。
  元素刻意很少，靠节奏和留白。每个会话只播一次（`sessionStorage`），点一下或按任意键立刻跳过，
  `prefers-reduced-motion` 下完全不播
- **无障碍**：键盘可达、`aria` 状态完整、`prefers-reduced-motion` 下关闭动效和光斑

## 想继续加东西的话

- 新文章：复制 `posts/nas-smb-slow.html`，改标题、正文、目录里的 `<a href="#id">` 与对应标题的 `id`
- 新导航项：所有页面顶栏的 `<nav>` 是重复的静态 HTML，改的时候一起改（共 11 个页面）
- 字体：目前只用系统字体栈，不加载外部字体，这样离线打开也不会变形

## 部署到 GitHub Pages

站点里所有引用都是**相对路径**、大小写与真实文件名一致、没有根绝对路径（`/assets/...`）、也没有 `<base>`，
所以放在仓库子目录（例如 `Blog/`）里能直接工作，放在仓库根目录也能。

**关键一点**：GitHub Pages 访问 `https://<用户名>.github.io/<仓库名>/` 时只会读该目录下的 `index.html`，
**不会**自动跳到 `Blog/`。如果仓库根目录已经有一个 `index.html`（另一个站点），访问时命中的就是它。

两种解决办法：

1. **根目录放一个跳转页（改动最小，两个站都留着）**
   把根目录的 `index.html` 先改名（例如 `old-index.html`，它的相对路径不变所以不会坏），
   再把本目录的 `deploy-root-index.html` 复制到根目录并改名为 `index.html`。
   它用 `location.replace("./Blog/")` 直接进站，另外带上 `<meta refresh>` 做无 JS 兜底。
   跳转页里有 `./Blog/` 两处，博客目录改名时一并改掉。

2. **把博客挪到仓库根目录（URL 最干净，不用跳转）**
   `git mv Blog/* .` 之后访问 `/仓库名/` 直接就是首页，页面地址也变成 `/仓库名/photography.html`。
   前提是根目录没有和 `assets/`、`posts/` 同名的目录会被覆盖，另外旧的 `index.html` 要先改名。

另外两点：

- 建议在仓库根目录放一个空的 `.nojekyll`，跳过 Jekyll 构建（更快，也不会被它的默认规则打扰）
- GitHub Pages 跑在 Linux 上，**路径区分大小写**。本目录的文件名已经全部是小写加连字符，
  引用也逐条核对过，可以直接过这一关
