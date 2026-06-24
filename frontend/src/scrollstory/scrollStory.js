// 原 scroll-story-demo/src/main.js 原样移植。
// 唯一改动:① 在场景 1、2 之间插入「地图页」(module: "map", 第 2 页),该层由 React 渲染,
// scroll story 不接管其 DOM;② 因此 renderAllScenes / buildPersistentLayouts 的图层下标后移一位;
// ③ 包成 initScrollStory() 并返回 destroy(),配合 React 卸载/StrictMode 双调用清理。
// 其余动画逻辑(tile 过渡、scrub 平移缩放、age 揭示)一律未改。
import { ageBinOrder, yearOrder } from "./mockData.js";
import { initHeroReveal } from "./heroReveal.js";

export function initScrollStory(storyData = {}) {
  // 真实数据(由 ScrollStory.tsx 从 /api/story/sample 拉来注入);保留 mockAlbums/mockArtistMoments 这两个名字,下游布局代码不必改
  const mockAlbums = storyData.albums || [];           // 第 3-4 页专辑(按年份)
  const ageAlbums = storyData.ageAlbums || [];          // 第 5 页上排专辑(按发行时年龄)
  const mockArtistMoments = storyData.artists || [];    // 第 5 页下排艺术家头像
  const yearCounts = storyData.yearCounts || {};   // {年: 真实专辑数},用于 scrub 标签显示真实段总量
  const scenes = [
    {
      key: "music-map",
      module: "intro",
      title: "MUSIC MAP",
      eyebrow: "Scene 1",
      body: "Reserved opening frame for the full music map."
    },
    {
      // 新增:地图页(MusicMap 三维封面地球),由 React 渲染进 data-layer="1"
      key: "music-map-globe",
      module: "map",
      title: "MAP",
      eyebrow: "Scene 2",
      body: ""
    },
    {
      key: "albums-by-year",
      module: "year",
      title: "ALBUMS / YEAR",
      eyebrow: "Scene 3",
      body: "把 2010–2025 划分为五个三年区块，对应时期发行的专辑封面在区块内纵向堆叠。用高度与密度直观对比各阶段的发行规模，呈现十五年间逐年专辑发行趋势。"
    },
    {
      key: "year-scrub",
      module: "scrub",
      title: "YEAR SWITCH",
      eyebrow: "Scene 4",
      body: "A larger version of the year-block view slides horizontally as the scroll moves through the four time spans.",
      scrollHeight: 280
    },
    {
      key: "albums-by-artist-age",
      module: "age",
      title: "ALBUMS / AGE",
      eyebrow: "Scene 5",
      body: "横轴从「公历年」切换为「艺人发行专辑时的年龄」。上层按年龄区间排布专辑封面，下层是对应艺人的头像点位，上下一一对应。点击任意封面即可高亮其作者，借此观察音乐人创作生命周期的分布规律。"
    }
  ];

  const sceneIndexByModule = Object.fromEntries(scenes.map((scene, index) => [scene.module, index]));
  let heroDestroy = null;   // 第 1 页 hero 的销毁句柄(在此提前声明,避免 renderAllScenes 早调用时 TDZ)

  // 转场页:在两个场景之间插入一段额外滚动(scrub),不计入上方进度栏。
  // heroMap:黑色 + 黑胶线右移退出 → 淡紫 + 星空 → 接地图;mapYear:地图 → 黑 → 格网从两侧拉出 → 接第 3 页。
  const transitions = [
    { after: 0, kind: "heroMap", vh: 120 },
    { after: 1, kind: "mapYear", vh: 120 },
  ];
  let applyHeroMap = () => {};
  let applyMapYear = () => {};
  const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  const colors = {
    album: "#4d8cff",
    artist: "#62d982",
    focus: "#d1b25f"
  };

  // 5 段均匀 3 年一段(2011–2025,共 15 年);从第 3 页切第 4 页就是缩放进首段 11-13
  const yearSegments = [
    { label: "11-13", start: 2011, end: 2013 },
    { label: "14-16", start: 2014, end: 2016 },
    { label: "17-19", start: 2017, end: 2019 },
    { label: "20-22", start: 2020, end: 2022 },
    { label: "23-25", start: 2023, end: 2025 }
  ];

  // 第 4 页 YEAR SWITCH 左侧文字栏:5 段各不相同。随横向滚动在 5 段之间纵向滑动切换。
  // (3→4、4→5 的进出由 animatePanelTransition 做同方向滑动,共 7 个文字帧)
  const yearSegmentInfo = [
    {
      range: "2011 – 2013", era: "数字转型加速期",
      lines: [
        ["Spotify 登陆美国，数字下载与实体并行，流媒体开始抬头。同时「唱片店日」壮大、黑胶销量回到二十年新高"],
      ],
    },
    {
      range: "2014 – 2016", era: "流媒体加速期",
      lines: [
        [ "流媒体加速扩张，2015 年 Apple Music 上线，消费从「拥有」转向「访问」。但 Taylor Swift 把《1989》撤出 Spotify（2014）、Adele《25》拒上流媒体——明星公开为实体与「拥有」站台。"],
      ],
    },
    {
      range: "2017 – 2019", era: "流媒体主导时代",
      lines: [
        ["2017 年流媒体成为全球最大收入来源、歌单决定爆款；但黑胶连续 12 年增长，靠限量变体与收藏品在「流量时代」另辟战场。"],
      ],
    },
    {
      range: "2020 – 2022", era: "传播逻辑重构",
      lines: [
        [ "疫情与 TikTok 重写音乐发现路径、流媒体彻底主流；但 2020 年美国黑胶收入 34 年来首次反超 CD;Adele《30》力推完整专辑、呼吁按顺序聆听"],
      ],
    },
    {
      range: "2023 – 2025", era: "科技与复古共生",
      lines: [
        ["流媒体饱和、AI 生成音乐与版权博弈升温；另一边 2022 年黑胶销量反超 CD、连续 16 年增长;Taylor Swift 多版本黑胶/CD 屡破纪录——超级粉丝用「购买」为实体续命。访问与拥有并存。"],
      ],
    },
  ];
  let scrubPanelShownIndex = 0;   // 文字栏当前显示的段索引(用于判断滑动方向/是否需要切换)

  // scrub 标签显示该段「真实」专辑总量(71K / 130K …),不是抽样的几十张
  const realSegmentCount = (segment) => {
    let s = 0;
    for (let y = segment.start; y <= segment.end; y++) s += yearCounts[String(y)] || 0;
    return s;
  };
  const fmtCount = (v) => (v >= 1000 ? Math.round(v / 1000) + "K" : String(v));

  const stage = document.querySelector("[data-stage]");
  const layers = [...document.querySelectorAll("[data-layer]")];
  const stepsContainer = document.querySelector("[data-steps]");
  const rail = document.querySelector("[data-rail]");
  const story = document.querySelector("#story");

  // 悬浮气泡:鼠标移到专辑/头像上,正上方显示「专辑名 - 艺术家」,圆角、宽度随文字自适应
  const tileTip = createElement("div", "tile-tip");
  stage.append(tileTip);
  function showTileTip(text, el) {
    if (!text) return;
    tileTip.textContent = text;
    const r = el.getBoundingClientRect();
    tileTip.style.left = `${r.left + r.width / 2}px`;
    tileTip.style.top = `${r.top - 10}px`;
    tileTip.classList.add("is-on");
  }
  function hideTileTip() { tileTip.classList.remove("is-on"); }

  // 金线串联:点击跨年龄段作者(featured)的头像 → 该作者各年龄段头像上浮 + 金色发光折线串起来
  const SVGNS = "http://www.w3.org/2000/svg";
  const linkSvg = document.createElementNS(SVGNS, "svg");
  linkSvg.setAttribute("class", "link-lines");
  const linkPath = document.createElementNS(SVGNS, "path");
  linkSvg.appendChild(linkPath);
  stage.append(linkSvg);
  // 第 3 页(ALBUMS / YEAR):蓝色专辑堆叠上方画一条「专辑增量曲线」,顺着各段堆顶起伏并标注真实总量
  const incrementSvg = document.createElementNS(SVGNS, "svg");
  incrementSvg.setAttribute("class", "increment-curve");
  incrementSvg.setAttribute("aria-hidden", "true");
  stage.append(incrementSvg);
  let incLine = null, incTraced = false, incTraceTimer = 0;   // 金线:进第3页后沿轨迹绘制
  function traceIncrementCurve(draw) {
    if (!incLine || !incLine.getTotalLength) return;
    const len = incLine.getTotalLength();
    if (!len) return;
    incLine.style.strokeDasharray = String(len);
    incLine.style.strokeDashoffset = draw ? "0" : String(len);   // CSS 过渡 → 从左到右画出
  }
  // 仅当「在第3页且覆盖层已退去(专辑已放)」才画金线 → 始终最后出现;离开则收起
  function maybeTraceCurve() {
    const onYear = currentScene === sceneIndexByModule.year && yearRevealed;
    if (onYear && !incTraced) {
      incTraced = true;
      window.clearTimeout(incTraceTimer);
      incTraceTimer = window.setTimeout(() => traceIncrementCurve(true), 700);   // 专辑飞入后再画
    } else if (!onYear && incTraced) {
      incTraced = false;
      window.clearTimeout(incTraceTimer);
      traceIncrementCurve(false);
    }
  }
  let linkedGroup = null;
  // Catmull-Rom → 三次贝塞尔,得到一条顺滑的金色细曲线
  function smoothPath(pts) {
    if (pts.length < 2) return "";
    let d = `M ${pts[0][0]},${pts[0][1]}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] || pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] || p2;
      const c1x = p1[0] + (p2[0] - p0[0]) / 6, c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6, c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ` C ${c1x},${c1y} ${c2x},${c2y} ${p2[0]},${p2[1]}`;
    }
    return d;
  }
  // 围绕「图形中心」放大:tile 基准盒 22px,中心(11,11);并进 transform 内层 → 居中放大且不挪位
  const CENTER_SCALE = " translate(11px,11px) scale(1.5) translate(-11px,-11px)";
  function clearLink() {
    document.querySelectorAll(".persistent-tile.is-lifted").forEach((n) => {
      if (n.dataset.baseTransform != null) {
        n.style.transform = n.dataset.baseTransform;   // 缩小(沿用 lift 设的 --duration,速率一致)
        delete n.dataset.baseTransform;
      }
      n.classList.remove("is-lifted");
    });
    linkSvg.classList.remove("is-on");   // 金线随缩小逐渐淡出(opacity 过渡;不立即清 d)
    linkedGroup = null;
  }
  function linkArtist(group) {
    clearLink();
    // 联动放大:该艺人的头像 + 上排专辑(data-am);金线只连头像(data-group)
    const lift = [...document.querySelectorAll(`.persistent-tile[data-am="${group}"]`)]
      .filter((n) => n.classList.contains("is-visible"));
    const avatars = lift.filter((n) => n.dataset.group === group);
    if (!avatars.length) return;
    const pts = avatars
      .map((n) => { const r = n.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })
      .sort((a, b) => a[0] - b[0]);
    linkPath.setAttribute("d", smoothPath(pts));
    linkSvg.classList.add("is-on");
    lift.forEach((n) => {
      n.style.setProperty("--duration", "260ms");   // 上浮/缩小同速、无错位延迟
      n.style.setProperty("--delay", "0");
      n.dataset.baseTransform = n.style.transform;
      n.style.transform = `${n.style.transform}${CENTER_SCALE}`;
      n.classList.add("is-lifted");
    });
    linkedGroup = group;
  }
  function onTileClick(node) {
    const g = node.dataset.group;
    if (!g || g === linkedGroup) { clearLink(); return; }
    linkArtist(g);
  }

  const albumTransition = createPersistentTileTransition({
    root: stage,
    items: mockAlbums,
    color: colors.album,
    className: "is-album"
  });

  const artistTransition = createPersistentTileTransition({
    root: stage,
    items: mockArtistMoments,
    color: colors.artist,
    className: "is-artist"
  });

  // 第 5 页上排专辑封面单独一层(与第 3-4 页那批不同,只在 age 场景出现)
  const ageAlbumTransition = createPersistentTileTransition({
    root: stage,
    items: ageAlbums,
    color: colors.album,
    className: "is-album"
  });

  let currentScene = 0;
  let activeScrubYear = yearSegments[0].start;
  let activeScrubSegmentIndex = 0;
  let ageRevealPhase = "age";
  let ageRevealTimer = 0;
  let scrubZoomPhase = "rest";
  let scrubZoomTimer = 0;
  let resizeFrame = 0;
  let resizeObserver = null;
  let windowResizeHandler = null;
  let snapLock = false;   // 滚轮吸附:一次手势只切一个锚点
  let snapTimer = 0;
  let autoScrolling = false;   // 序章自动播放:滚一下自动滚到地图页
  let autoRaf = 0;
  let yearRevealed = false;    // 2→3 转场:覆盖层退去后才放第3页专辑(让左→右飞入可见)

  buildRail();
  buildSteps();
  buildTransitions();
  renderAllScenes();
  setScene(0);
  observeSteps();
  window.addEventListener("wheel", onWheelSnap, { passive: false });

  if ("ResizeObserver" in window) {
    resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => {
        renderAllScenes();
        updateFromScroll();
      });
    });
    resizeObserver.observe(stage);
  } else {
    windowResizeHandler = () => {
      renderAllScenes();
      updateFromScroll();
    };
    window.addEventListener("resize", windowResizeHandler);
  }

  function buildRail() {
    if (!rail) return;   // chapter-rail 已移除(导航改为滚轮吸附)
    rail.innerHTML = scenes
      .map(
        (scene, index) => `
          <button class="rail-chapter" type="button" data-rail-item="${index}">
            <span class="rail-text">${index + 1} - ${scene.title}</span>
            <span class="rail-blocks" aria-hidden="true">
              <span></span><span></span><span></span><span></span>
            </span>
          </button>
        `
      )
      .join("");

    rail.querySelectorAll("[data-rail-item]").forEach((button) => {
      button.addEventListener("click", () => {
        const index = Number(button.dataset.railItem);
        const target = document.querySelector(`.scroll-step[data-scene="${index}"]`);
        target?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
  }

  function buildSteps() {
    // 场景步骤之间插入转场步骤(data-trans);转场步骤不带 data-scene → 不进吸附锚点/进度栏
    const seq = [];
    scenes.forEach((scene, index) => {
      seq.push({ kind: "scene", index, vh: scene.scrollHeight || 112 });
      const t = transitions.find((tr) => tr.after === index);
      if (t) seq.push({ kind: "trans", trans: t.kind, vh: t.vh });
    });
    const totalVh = seq.reduce((sum, x) => sum + x.vh, 0);
    document.documentElement.style.setProperty("--story-min-height", `${totalVh}vh`);
    document.documentElement.style.setProperty("--scene-count", String(scenes.length));

    stepsContainer.replaceChildren(
      ...seq.map((x) =>
        createElement("section", `scroll-step${x.kind === "trans" ? " is-trans" : ""}`, {
          attrs: x.kind === "scene" ? { "data-scene": String(x.index) } : { "data-trans": x.trans },
          style: `height:${x.vh}vh`
        })
      )
    );

    if (story) {
      story.style.setProperty("--story-min-height", `${totalVh}vh`);
    }
  }

  function observeSteps() {
    window.addEventListener("scroll", updateFromScroll, { passive: true });
    window.addEventListener("resize", updateFromScroll);
    updateFromScroll();
  }

  // 锚点列表:普通场景=该页居中位置;scrub 场景按 4 个年份段细分 → 每次滚轮停一段
  // 转场覆盖层(挂在 stage,z 介于场景/tile 与进度栏之间):heroMap 淡紫+星空、mapYear 黑+格网拉出
  function buildTransitions() {
    const thm = createElement("div", "trans-overlay trans-hero-map");
    const thmBlack = createElement("div", "thm-black");      // 纯黑相
    const thmFill = createElement("div", "thm-fill");        // 淡紫(贴地图底色)
    const thmStars = createElement("div", "thm-stars");
    let starsHtml = "";
    for (let i = 0; i < 80; i++) {
      const x = (Math.random() * 100).toFixed(2);
      const y = (35 + Math.random() * 64).toFixed(2);          // 偏下半屏
      const s = (1 + Math.random() * 1.7).toFixed(2);
      const o = (0.35 + Math.random() * 0.6).toFixed(2);
      starsHtml += `<span style="left:${x}%;top:${y}%;width:${s}px;height:${s}px;--o:${o}"></span>`;
    }
    thmStars.innerHTML = starsHtml;
    thm.append(thmBlack, thmFill, thmStars);

    const tmy = createElement("div", "trans-overlay trans-map-year");
    const tmyPurple = createElement("div", "tmy-purple");   // 星空+淡紫:贴地图底色,无缝盖上(过渡色)
    let myStars = "";
    for (let i = 0; i < 80; i++) {
      const x = (Math.random() * 100).toFixed(2);
      const y = (Math.random() * 100).toFixed(2);
      const s = (1 + Math.random() * 1.7).toFixed(2);
      const o = (0.35 + Math.random() * 0.6).toFixed(2);
      myStars += `<span style="left:${x}%;top:${y}%;width:${s}px;height:${s}px;--o:${o}"></span>`;
    }
    tmyPurple.innerHTML = myStars;
    const tmyBlack = createElement("div", "tmy-black");      // 第 3 页黑底色
    const tmyGrid = createElement("div", "tmy-grid");
    const GRID = 72, NV = 28;                                 // 竖线对齐第 3 页的 72px 背景格网 → 拉合完无缝衔接
    const vlines = [];
    for (let i = 0; i < NV; i++) {
      const ln = createElement("div", "tmy-vline");
      ln.style.left = `${i * GRID}px`;
      tmyGrid.append(ln);
      vlines.push(ln);
    }
    tmy.append(tmyPurple, tmyBlack, tmyGrid);

    stage.append(thm, tmy);
    const backEase = (t) => { const c1 = 1.70158, c3 = c1 + 1; const u = t - 1; return 1 + c3 * u * u * u + c1 * u * u; };

    applyHeroMap = (p) => {
      const fn = layers[0] && layers[0].heroSetExit;      // 黑胶线右移 + 标题逐字退出(hero 自己画)
      if (fn) fn(p);
      // 黑幕在地图激活(≈0.53)前盖满,且升到 1 后「一直保持」(底层永远遮住);
      // 淡紫盖在黑幕「之上」做黑→紫的视觉,避免交叉淡化时两层合成透明度不足而透出地图。
      // 最后整体一起退去露出地图。
      thmBlack.style.opacity = String(smoothstep(0.42, 0.51, p));
      thmFill.style.opacity = String(smoothstep(0.62, 0.80, p));
      thmStars.style.opacity = String(smoothstep(0.72, 0.90, p));
      thm.style.opacity = String(1 - smoothstep(0.9, 1.0, p));
    };

    applyMapYear = (p) => {
      // 地图 →(星空/淡紫无缝盖上)→ 黑(第3页底色,升满保持)→ 背景格网从两侧拉合 → 退去无缝衔接第3页
      tmyPurple.style.opacity = String(smoothstep(0.28, 0.42, p));   // 星空/淡紫先盖满(垫底遮挡)
      tmyBlack.style.opacity = String(smoothstep(0.40, 0.62, p));    // 星空→黑放慢到 ~0.5s(底下淡紫垫着,不会闪地图)
      const gp = smoothstep(0.5, 0.86, p);
      const cx = (window.innerWidth || 1) / 2;
      for (let i = 0; i < NV; i++) {
        const x = i * GRID;
        const fromLeft = x < cx;
        const norm = Math.min(1, Math.abs(x - cx) / cx);  // 0 中心 .. 1 边缘 → 中间先拉、边缘后到
        const local = clamp((gp - norm * 0.32) / 0.68, 0, 1);
        const e = backEase(local);                        // 过冲 → 从两侧「拉」到位的弹力
        vlines[i].style.transform = `translateX(${((1 - e) * (fromLeft ? -60 : 60)).toFixed(2)}vw)`;
        vlines[i].style.opacity = String(clamp(local * 1.5, 0, 1));
      }
      tmy.style.opacity = String(1 - smoothstep(0.86, 1.0, p));
      // 拉合完成(覆盖层将退)→ 给第3页打 is-revealed,触发其元素按方向飞入(衔接动画)
      const reveal = p >= 0.9;
      const yLayer = layers[2];
      if (yLayer) yLayer.classList.toggle("is-revealed", reveal);
      // reveal 跨越时:此刻才放第3页专辑(原左→右飞入此时可见);收起时退回隐藏
      if (reveal !== yearRevealed) {
        yearRevealed = reveal;
        if (currentScene === sceneIndexByModule.year) {
          albumTransition.update(reveal ? sceneIndexByModule.year : sceneIndexByModule.map);
        }
        maybeTraceCurve();   // reveal 后(专辑已放)才画金线;收起则撤
      }
    };
  }

  // 自定义自动滚动(easeInOutQuad):用于序章「滚一下自动播放到地图页」,过程中转场随 scrollY 自动 scrub
  function autoScrollTo(targetY, duration) {
    const startY = window.scrollY;
    const dist = targetY - startY;
    if (Math.abs(dist) < 2) return;
    autoScrolling = true;
    const t0 = performance.now();
    const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
    cancelAnimationFrame(autoRaf);
    const step = (now) => {
      const t = Math.min(1, (now - t0) / duration);
      window.scrollTo(0, Math.round(startY + dist * ease(t)));
      if (t < 1) autoRaf = requestAnimationFrame(step);
      else autoScrolling = false;
    };
    autoRaf = requestAnimationFrame(step);
  }

  function buildSnapAnchors() {
    // 只在「场景」步骤设吸附锚点;转场步骤夹在中间,由 scrollTo 平滑滚动时被自然扫过(动画随之 scrub)
    const steps = [...document.querySelectorAll(".scroll-step[data-scene]")];
    const vh = window.innerHeight;
    const anchors = [];
    steps.forEach((step) => {
      const i = Number(step.dataset.scene);
      if (i === 0) return;   // 序章 hero 不设吸附点:序章→地图是连续自由滚动
      if (scenes[i] && scenes[i].module === "scrub") {
        const dist = Math.max(1, step.offsetHeight - vh);
        const n = yearSegments.length;
        for (let k = 0; k < n; k++) anchors.push(step.offsetTop + (k / (n - 1)) * dist);
      } else {
        anchors.push(step.offsetTop + step.offsetHeight / 2 - vh / 2);
      }
    });
    return anchors.map((y) => Math.max(0, Math.round(y)));
  }

  // 一次滚轮手势 = 前进/后退一个锚点(平滑滚动)。地图页指针在三维地球上时放行给 OrbitControls 缩放。
  function onWheelSnap(e) {
    if (currentScene === sceneIndexByModule.map && e.target && e.target.tagName === "CANVAS") return;
    // 曲风菜单内滚动:阻止翻页/页面滚动;若在细分浮层上则手动滚它(粗桶区不滚)
    if (e.target && e.target.closest) {
      const gm = e.target.closest(".gm-fines, .genre-menu");
      if (gm) {
        const fines = e.target.closest(".gm-fines");
        if (fines) fines.scrollTop += e.deltaY;
        e.preventDefault();
        return;
      }
    }
    if (Math.abs(e.deltaY) < 2) return;
    // 序章(页顶 ↔ 地图页顶):滚一下「自动播放」整段转场,自动滚到地图页停住(向上则自动回序章顶)
    const mapStep = document.querySelector('.scroll-step[data-scene="1"]');
    const yearStep = document.querySelector('.scroll-step[data-scene="2"]');
    const mapTop = mapStep ? mapStep.offsetTop : 0;
    const yearTop = yearStep ? yearStep.offsetTop : mapTop;
    const vh = window.innerHeight;
    const dir0 = e.deltaY > 0 ? 1 : -1;
    if (autoScrolling) { e.preventDefault(); return; }                 // 自动播放中:吞掉滚轮
    // 序章 hero ↔ 地图
    if (dir0 > 0 && window.scrollY < mapTop - 4) { e.preventDefault(); autoScrollTo(mapTop, 2300); return; }
    if (dir0 < 0 && window.scrollY <= mapTop + vh * 0.5) { e.preventDefault(); autoScrollTo(0, 1600); return; }
    // 地图 ↔ 第 3 页(同样自动播放:星空→淡紫→黑→格网拉合→第3页)
    if (dir0 > 0 && window.scrollY < yearTop - 4) { e.preventDefault(); autoScrollTo(yearTop, 2300); return; }
    if (dir0 < 0 && window.scrollY <= yearTop + vh * 0.5) { e.preventDefault(); autoScrollTo(mapTop, 1800); return; }
    e.preventDefault();
    if (snapLock) return;
    const anchors = buildSnapAnchors();
    if (!anchors.length) return;
    const cur = window.scrollY;
    let nearest = 0;
    let best = Infinity;
    anchors.forEach((y, i) => {
      const d = Math.abs(y - cur);
      if (d < best) { best = d; nearest = i; }
    });
    const dir = e.deltaY > 0 ? 1 : -1;
    const next = Math.max(0, Math.min(anchors.length - 1, nearest + dir));
    if (next === nearest) return;
    snapLock = true;
    window.scrollTo({ top: anchors[next], behavior: "smooth" });
    snapTimer = window.setTimeout(() => { snapLock = false; }, 600);
  }

  function updateFromScroll() {
    const viewportCenter = window.scrollY + window.innerHeight * 0.5;
    // 当前场景:只看「场景」步骤(转场步骤不参与),取中心最近的
    const closest = [...document.querySelectorAll(".scroll-step[data-scene]")].reduce(
      (best, step) => {
        const center = step.offsetTop + step.offsetHeight * 0.5;
        const distance = Math.abs(center - viewportCenter);
        return distance < best.distance ? { step, distance } : best;
      },
      { step: null, distance: Infinity }
    );

    if (closest.step) {
      setScene(Number(closest.step.dataset.scene));
    }

    updateTransitions();
    updateScrubYear();
  }

  function updateTransitions() {
    const mapStep = document.querySelector('.scroll-step[data-scene="1"]');
    const yearStep = document.querySelector('.scroll-step[data-scene="2"]');
    // heroMap:页顶 → 地图页顶 连续
    if (mapStep) applyHeroMap(clamp(window.scrollY / Math.max(1, mapStep.offsetTop), 0, 1));
    // mapYear:地图页顶 → 第3页顶 连续
    if (mapStep && yearStep) {
      const span = Math.max(1, yearStep.offsetTop - mapStep.offsetTop);
      applyMapYear(clamp((window.scrollY - mapStep.offsetTop) / span, 0, 1));
    }
  }

  function updateScrubYear() {
    const scrubStep = document.querySelector(`.scroll-step[data-scene="${sceneIndexByModule.scrub}"]`);
    if (!scrubStep) return;

    const scrollableDistance = Math.max(1, scrubStep.offsetHeight - window.innerHeight);
    const progress = clamp(
      (window.scrollY - scrubStep.offsetTop) / scrollableDistance,
      0,
      1
    );
    const nextSegmentIndex = Math.round(progress * (yearSegments.length - 1));
    const nextYear = yearSegments[nextSegmentIndex].start;

    if (nextSegmentIndex !== activeScrubSegmentIndex || nextYear !== activeScrubYear) {
      activeScrubSegmentIndex = nextSegmentIndex;
      activeScrubYear = nextYear;
      updateSceneFourVisualState();
      updatePersistentLayouts();
    }
  }

  function setScene(index, options = {}) {
    const previousScene = currentScene;
    const nextScene = clamp(index, 0, scenes.length - 1);
    const enteringScrubFromYear =
      !options.skipSequence &&
      previousScene === sceneIndexByModule.year &&
      nextScene === sceneIndexByModule.scrub;
    const enteringAgeFromScrub =
      !options.skipSequence &&
      previousScene === sceneIndexByModule.scrub &&
      nextScene === sceneIndexByModule.age;

    currentScene = nextScene;

    if (enteringScrubFromYear) {
      startScrubZoomSequence();
    } else if (!options.skipSequence && nextScene !== sceneIndexByModule.scrub) {
      resetScrubZoomSequence();
    }

    if (enteringAgeFromScrub) {
      startAgeRevealSequence();
    } else if (!options.skipSequence && nextScene !== sceneIndexByModule.age && ageRevealPhase !== "age") {
      resetAgeRevealSequence();
      updatePersistentLayouts();
    }

    const displayScene = getDisplaySceneIndex(currentScene);
    stage.dataset.scene = String(currentScene + 1);
    stage.dataset.module = scenes[currentScene].module;
    stage.dataset.displayModule = scenes[displayScene].module;
    stage.dataset.activeYear = String(activeScrubYear);
    stage.dataset.agePhase = ageRevealPhase;
    stage.dataset.scrubZoom = scrubZoomPhase;

    layers.forEach((layer, layerIndex) => {
      layer.classList.toggle("is-active", layerIndex === displayScene);
    });

    // 专辑增量曲线只在第 3 页(year 布局)出现;金线在覆盖层退去、专辑放好后才画(见 maybeTraceCurve)
    incrementSvg.classList.toggle("is-on", displayScene === sceneIndexByModule.year);
    maybeTraceCurve();

    if (rail) {
      rail.querySelectorAll("[data-rail-item]").forEach((item, itemIndex) => {
        item.classList.toggle("is-active", itemIndex === currentScene);
        item.setAttribute("aria-current", itemIndex === currentScene ? "step" : "false");
      });
    }

    // 3→4、4→5 跨场景:文字栏同方向滑动进出(resize 的 skipSequence 重算不触发)
    if (!options.skipSequence && previousScene !== currentScene) {
      animatePanelTransition(previousScene, currentScene);
    }

    updateSceneFourVisualState();
    // 第3页专辑:转场覆盖层退去(yearRevealed)前先扣住(当作空的地图布局),
    // 否则飞入发生在黑幕底下、退去时已就位 → 看不见左→右飞入。
    const albumScene = (currentScene === sceneIndexByModule.year && !yearRevealed)
      ? sceneIndexByModule.map : currentScene;
    albumTransition.update(albumScene);
    ageAlbumTransition.update(currentScene);
    artistTransition.update(currentScene);
    if (linkedGroup && currentScene !== sceneIndexByModule.age) clearLink();
  }

  function renderAllScenes() {
    renderSceneOne(layers[0], scenes[0]);
    // layers[1] 是地图页,由 React 接管,这里不渲染
    renderSceneTwo(layers[2], scenes[2]);
    renderSceneFour(layers[3], scenes[3]);
    renderSceneThree(layers[4], scenes[4]);
    updatePersistentLayouts();
  }

  function updatePersistentLayouts() {
    if (linkedGroup) clearLink();   // 布局重算前先收起金线/放大,避免 transform 被覆盖后错乱
    const layouts = buildPersistentLayouts();
    albumTransition.setLayouts(layouts.albums);
    ageAlbumTransition.setLayouts(layouts.ageAlbums);
    artistTransition.setLayouts(layouts.artists);
    setScene(currentScene, { skipSequence: true });
  }

  function getDisplaySceneIndex(sceneIndex) {
    if (sceneIndex === sceneIndexByModule.age && ageRevealPhase === "reset") {
      return sceneIndexByModule.year;
    }

    return sceneIndex;
  }

  function startScrubZoomSequence() {
    resetScrubZoomSequence();
    scrubZoomPhase = "from-year";
    scrubZoomTimer = window.setTimeout(() => {
      if (currentScene !== sceneIndexByModule.scrub) return;
      scrubZoomPhase = "rest";
      updateSceneFourVisualState();
      stage.dataset.scrubZoom = scrubZoomPhase;
    }, 90);
  }

  function resetScrubZoomSequence() {
    window.clearTimeout(scrubZoomTimer);
    scrubZoomTimer = 0;
    scrubZoomPhase = "rest";
  }

  function startAgeRevealSequence() {
    // 第 5 页用独立的一批专辑/头像,直接平滑淡入(不再回放年份网格)
    resetAgeRevealSequence();
    ageRevealPhase = "age";
    updatePersistentLayouts();
  }

  function resetAgeRevealSequence() {
    window.clearTimeout(ageRevealTimer);
    ageRevealTimer = 0;
    ageRevealPhase = "age";
  }

  // 第 1 页 = 封面 hero(鼠标轨迹生成像素毛边封面)。只挂一次;resize 由 hero 内部处理,
  // 故 renderAllScenes 的重复调用直接忽略(否则会重复挂载/泄漏 RAF)。heroDestroy 在顶部已声明。
  function renderSceneOne(layer) {
    if (heroDestroy) return;
    heroDestroy = initHeroReveal(layer);
  }

  function renderSceneTwo(layer, scene) {
    layer.replaceChildren();

    const dims = getTimelineDimensions("year");

    layer.append(
      createElement("div", "map-rule", { style: `top:${dims.baselineY}px` }),
      createTitlePanel(scene),
      createSceneNote("Each three-year span is one block, with its albums stacked inside.", dims),
      createSideLabel("Albums", colors.album, dims.leftLabelX, dims.baselineY - dims.labelOffset),
      ...createSegmentBands(dims),
      ...createSegmentDividers(dims),
      ...createYearRangeLabels(dims),
      createLegend([["albums", colors.album]])
    );

    updateIncrementCurve();
  }

  // 专辑增量曲线:取 2011–2025 每年的真实专辑量,轻度平滑后拟合成一条顺滑曲线(非折线),
  // 横跨整段时间轴、浮在所有蓝色专辑堆叠之上 → 一眼看出逐年增长趋势。
  function updateIncrementCurve() {
    const dims = getTimelineDimensions("year");
    const step = dims.segmentTileSize + dims.gap;
    const groupWidth = dims.usableWidth / yearSegments.length;
    const maxRows = Math.max(2, Math.floor(dims.topMatrixHeight / step));

    // 最高一段堆叠的上沿 → 曲线整体压在它之上,保证浮在所有专辑上方不重叠
    let stackTopY = dims.baselineY;
    for (const segment of yearSegments) {
      const count = mockAlbums.filter((a) => yearInSegment(a.year, segment)).length;
      const columns = Math.max(2, Math.floor((groupWidth - dims.gap * 4) / step));
      const rows = Math.max(1, Math.ceil(Math.min(count, maxRows * columns) / columns));
      stackTopY = Math.min(stackTopY, dims.baselineY - rows * step - 10);
    }

    // 逐年真实量 → 5 点高斯权重滑动平均当拟合,抹掉年度抖动,曲线才不会拐成折线
    const startY = yearSegments[0].start, endY = yearSegments[yearSegments.length - 1].end;
    const raw = [];
    for (let y = startY; y <= endY; y++) raw.push(yearCounts[String(y)] || 0);
    const fit = raw.map((_, i) => {
      let s = 0, w = 0;
      for (let k = -2; k <= 2; k++) {
        const j = i + k;
        if (j < 0 || j >= raw.length) continue;
        const wk = 3 - Math.abs(k);
        s += raw[j] * wk; w += wk;
      }
      return s / w;
    });
    const vmin = Math.min(...fit), vmax = Math.max(...fit), span = vmax - vmin || 1;

    const bandLow = stackTopY - 22;                                   // 贴着最高堆叠上沿
    const bandH = Math.min(86, Math.max(48, dims.topMatrixHeight * 0.5));
    const n = fit.length;
    const pts = fit.map((v, i) => [
      Math.round(dims.leftPad + (i / (n - 1)) * dims.usableWidth),
      Math.round(bandLow - ((v - vmin) / span) * bandH)
    ]);

    while (incrementSvg.firstChild) incrementSvg.removeChild(incrementSvg.firstChild);
    const path = document.createElementNS(SVGNS, "path");
    path.setAttribute("class", "inc-line");
    path.setAttribute("d", smoothPath(pts));
    incrementSvg.appendChild(path);
    incLine = path;
    const len = path.getTotalLength ? path.getTotalLength() : 0;
    if (len) {
      path.style.strokeDasharray = String(len);
      path.style.strokeDashoffset = String(incTraced ? 0 : len);   // 未进场=隐藏;已画好(如 resize)=保持
    }
  }

  function renderSceneThree(layer, scene) {
    layer.replaceChildren();

    const dims = getTimelineDimensions("age");

    layer.append(
      createElement("div", "map-rule", { style: `top:${dims.baselineY}px` }),
      createTitlePanel(scene),
      createSceneNote("The x-axis now means artist age when the album was released.", dims),
      createSideLabel("Albums", colors.album, dims.leftLabelX, dims.baselineY - dims.labelOffset),
      createSideLabel("Artists", colors.artist, dims.leftLabelX, dims.baselineY + dims.labelOffset),
      ...createAxisTicks(ageBinOrder, dims),
      ...createAxisLabels(ageBinOrder, dims, { majorValues: ["18-24", "30-34", "40-44", "50-54", "60+"] }),
      createLegend([
        ["albums", colors.album],
        ["artists at release", colors.artist]
      ])
    );
  }

  function renderSceneFour(layer, scene) {
    layer.replaceChildren();

    const dims = getTimelineDimensions("scrub");
    const segment = yearSegments[activeScrubSegmentIndex];
    const activeCount = fmtCount(realSegmentCount(segment));   // 真实段总量,如 130K
    const track = getScrubTrack(dims, activeScrubSegmentIndex);
    const labelRight = dims.compact ? 16 : 44;
    const labelTop = Math.max(88, dims.baselineY - dims.topMatrixHeight - (dims.compact ? 6 : 14));

    layer.append(
      createScrubPanel(activeScrubSegmentIndex),
      createElement("div", "scrub-year-label", {
        text: segment.label,
        style: `right:${labelRight}px; top:${labelTop}px;`
      }),
      createElement("div", "scrub-count", {
        text: `${activeCount} albums`,
        style: `right:${labelRight + 4}px; top:${labelTop + (dims.compact ? 82 : 188)}px;`
      }),
      createScrubTrack(dims, track),
      createLegend([
        ["active block", colors.focus],
        ["other blocks", colors.album]
      ])
    );
  }

  // YEAR SWITCH 左侧文字栏:窗口(overflow:hidden)内放一个文字帧,切段时旧帧上滑飞出、新帧从下滑入
  function buildScrubFrame(index) {
    const info = yearSegmentInfo[index] || yearSegmentInfo[0];
    const frame = createElement("div", "panel-frame");
    frame.append(
      createElement("p", "eyebrow", { text: `YEAR SWITCH · ${info.range}` }),
      createElement("h2", "", { text: info.era })
    );
    const body = createElement("div", "panel-body");
    info.lines.forEach((line) => {
      // line 可为字符串或数组(数组则拼成一句);避免 value 缺失渲染出 "undefined"
      const text = Array.isArray(line) ? line.filter(Boolean).join("") : line;
      body.append(createElement("p", "panel-line", { text }));
    });
    frame.append(body);
    return frame;
  }

  function createScrubPanel(index) {
    const panel = createElement("aside", "text-panel is-scrub");
    const reel = createElement("div", "panel-reel");
    reel.append(buildScrubFrame(index));
    panel.append(reel);
    scrubPanelShownIndex = index;
    // 入 DOM 后按当前帧高度撑开窗口(帧为绝对定位,窗口需显式高度才能裁掉滑出的帧)
    requestAnimationFrame(() => {
      const f = reel.firstChild;
      if (f) reel.style.height = `${f.offsetHeight}px`;
    });
    return panel;
  }

  // 在 reel 里把文字帧从 index 切到 nextIndex:dir>0 新帧从下进、旧帧上飞;dir<0 反向
  function slideScrubPanel(reel, nextIndex, dir) {
    const outgoing = reel.lastChild;
    const incoming = buildScrubFrame(nextIndex);
    incoming.style.transition = "none";
    incoming.style.opacity = "0";
    incoming.style.transform = `translateY(${dir >= 0 ? 110 : -110}%)`;
    reel.append(incoming);
    reel.style.height = `${incoming.offsetHeight}px`;
    void incoming.offsetWidth;   // 强制重排,让起始态生效
    incoming.style.transition = "";
    requestAnimationFrame(() => {
      incoming.style.opacity = "1";
      incoming.style.transform = "translateY(0)";
      if (outgoing) {
        outgoing.style.opacity = "0";
        outgoing.style.transform = `translateY(${dir >= 0 ? -110 : 110}%)`;
      }
    });
    window.setTimeout(() => { if (outgoing && outgoing.parentNode) outgoing.remove(); }, 640);
    scrubPanelShownIndex = nextIndex;
  }

  // 3→4、4→5 跨场景:让进入场景的文字栏从下滑入、离开场景的文字栏上飞出(与段内滑动同方向)
  function animatePanelTransition(prevScene, nextScene) {
    if (prevScene === nextScene) return;
    const fwd = nextScene > prevScene;
    const pick = (i) => {
      const el = layers[i];
      return el ? el.querySelector(".text-panel.is-scrub, .text-panel.is-age") : null;
    };
    const incoming = pick(nextScene);
    if (incoming) {
      incoming.style.transition = "none";
      incoming.style.transform = `translateY(${fwd ? 46 : -46}px)`;
      incoming.style.opacity = "0";
      void incoming.offsetWidth;
      incoming.style.transition = "transform .6s cubic-bezier(.6,0,.2,1), opacity .55s ease";
      requestAnimationFrame(() => {
        incoming.style.transform = "translateY(0)";
        incoming.style.opacity = "1";
      });
    }
    const outgoing = pick(prevScene);
    if (outgoing) {
      outgoing.style.transition = "transform .5s cubic-bezier(.6,0,.2,1), opacity .45s ease";
      outgoing.style.transform = `translateY(${fwd ? -64 : 64}px)`;
      outgoing.style.opacity = "0";
    }
  }

  function updateSceneFourVisualState() {
    const layer = layers[sceneIndexByModule.scrub];
    const trackElement = layer.querySelector(".scrub-track");

    if (!trackElement) return;

    const dims = getTimelineDimensions("scrub");
    const segment = yearSegments[activeScrubSegmentIndex];
    const activeCount = fmtCount(realSegmentCount(segment));   // 真实段总量
    const track = getScrubTrack(dims, activeScrubSegmentIndex);

    applyScrubTrackState(trackElement, dims, track);
    layer.querySelector(".scrub-year-label").textContent = segment.label;
    layer.querySelector(".scrub-count").textContent = `${activeCount} albums`;

    layer.querySelectorAll("[data-segment-index]").forEach((node) => {
      node.classList.toggle("is-active", Number(node.dataset.segmentIndex) === activeScrubSegmentIndex);
    });

    // 左侧文字栏:段变了就纵向滑动切到对应文字(滚动方向决定上飞/下飞)
    const reel = layer.querySelector(".panel-reel");
    if (reel && scrubPanelShownIndex !== activeScrubSegmentIndex) {
      slideScrubPanel(reel, activeScrubSegmentIndex, activeScrubSegmentIndex - scrubPanelShownIndex);
    }
  }

  function buildPersistentLayouts() {
    const yearDims = getTimelineDimensions("year");
    const ageDims = getTimelineDimensions("age");
    const scrubDims = getTimelineDimensions("scrub");
    const yearLayout = albumSegmentLayout(mockAlbums, yearDims);
    const ageAlbumLayout =
      ageRevealPhase === "reset"
        ? albumSegmentLayout(mockAlbums, yearDims, { direct: true, duration: "680ms" })
        : albumAgeLayout(mockAlbums, ageDims, "up");
    const ageArtistLayout =
      ageRevealPhase === "reset" ? [] : albumAgeLayout(mockArtistMoments, ageDims, "down");
    // 第 5 页上排专辑(独立一批):reset 阶段先藏,age 阶段按年龄铺开
    const ageAlbumsUp =
      ageRevealPhase === "reset" ? [] : albumAgeLayout(ageAlbums, ageDims, "up");

    // 下标对应 scenes:0=intro 1=map(空) 2=year 3=scrub 4=age
    return {
      albums: [
        [],
        [],
        yearLayout,
        segmentPanLayout(mockAlbums, scrubDims, activeScrubSegmentIndex, yearDims),
        ageAlbumLayout
      ],
      ageAlbums: [
        [],
        [],
        [],
        [],
        ageAlbumsUp
      ],
      artists: [
        [],
        [],
        [],
        [],
        ageArtistLayout
      ]
    };
  }

  function createPersistentTileTransition({ root, items, color, className }) {
    const layer = createElement("div", `persistent-tile-layer ${className}`, {
      attrs: { "aria-hidden": "true" }
    });
    const nodes = new Map();
    const defaultSize = 22;
    let layoutMaps = [];

    root.append(layer);

    items.forEach((item, index) => {
      const node = createElement("img", "persistent-tile", {
        attrs: {
          src: item.image,
          alt: "",
          loading: "lazy",
          "data-id": item.id
        }
      });

      // 气泡文字:专辑「专辑名 - 艺术家」;艺术家头像则只显示姓名
      const tip = item.title && item.artist ? `${item.title} - ${item.artist}`
        : (item.title || item.name || item.artist || "");
      node.dataset.tip = tip;
      node.addEventListener("pointerenter", () => showTileTip(node.dataset.tip, node));
      node.addEventListener("pointerleave", hideTileTip);

      // 跨年龄段作者:发光边框 + 点击金线串联;data-am 让「点艺人 → 其专辑也联动放大」
      if (item.featured) node.classList.add("is-featured");
      if (item.group) node.dataset.group = item.group;
      if (item.artistMbid) node.dataset.am = item.artistMbid;
      node.addEventListener("click", () => onTileClick(node));
      // 图片加载失败(没头像/没封面)→ 剔除,不留灰色占位块
      node.addEventListener("error", () => { nodes.delete(item.id); node.remove(); });

      node.dataset.delay = String(index % 120);
      node.style.setProperty("--accent", color);
      layer.append(node);
      nodes.set(item.id, node);
    });

    return {
      setLayouts(layouts) {
        layoutMaps = layouts.map((layout) => new Map(layout.map((tile) => [tile.id, tile])));
        this.update(currentScene);
      },
      update(sceneIndex) {
        const targets = layoutMaps[sceneIndex] || new Map();

        nodes.forEach((node, id) => {
          const target = targets.get(id);

          if (!target) {
            node.classList.remove("is-visible");
            return;
          }

          const scale = (target.size || defaultSize) / defaultSize;
          const previousX = Number(node.dataset.x ?? target.x);
          const previousY = Number(node.dataset.y ?? target.y);
          const travelDistance = Math.hypot(target.x - previousX, target.y - previousY);
          const travelDelay = target.direct ? 0 : Math.min(28, Math.round(travelDistance / 44));
          const baseDelay = target.direct ? 0 : Number(target.delay ?? node.dataset.delay ?? 0);

          node.style.transform = `translate3d(${target.x}px, ${target.y}px, 0) scale(${scale})`;
          node.style.setProperty("--opacity", target.opacity ?? 0.96);
          node.style.setProperty("--delay", String(baseDelay + travelDelay));
          node.style.setProperty("--duration", target.duration ?? "680ms");
          node.dataset.x = String(target.x);
          node.dataset.y = String(target.y);
          node.dataset.delay = String(baseDelay);
          node.classList.add("is-visible");
        });
      },
      destroy() {
        layer.remove();
      }
    };
  }

  function albumSegmentLayout(items, dims, options = {}) {
    const step = dims.segmentTileSize + dims.gap;
    const groupWidth = dims.usableWidth / yearSegments.length;
    const maxRows = Math.max(2, Math.floor(dims.topMatrixHeight / step));
    const direct = Boolean(options.direct);

    return yearSegments.flatMap((segment, groupIndex) => {
      const groupItems = items.filter((item) => yearInSegment(item.year, segment));
      const columns = Math.max(2, Math.floor((groupWidth - dims.gap * 4) / step));
      const limit = Math.min(groupItems.length, maxRows * columns);
      const startX = dims.leftPad + groupIndex * groupWidth + (groupWidth - columns * step + dims.gap) / 2;

      return groupItems.slice(0, limit).map((item, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);

        return {
          id: item.id,
          segmentIndex: groupIndex,
          row,
          column,
          x: Math.round(startX + column * step),
          y: Math.round(dims.baselineY - (row + 1) * step - 10),
          size: dims.segmentTileSize,
          opacity: options.opacity ?? 0.96,
          delay: direct ? 0 : staggerDelay({ groupIndex, row, column, index, mode: "grid" }),
          duration: options.duration ?? "720ms",
          direct
        };
      });
    });
  }

  function albumAgeLayout(items, dims, direction) {
    const step = dims.tileSize + dims.gap;
    const groupWidth = dims.usableWidth / ageBinOrder.length;
    const maxHeight = direction === "up" ? dims.topMatrixHeight : dims.bottomMatrixHeight;
    const maxRows = Math.max(2, Math.floor(maxHeight / step));

    return ageBinOrder.flatMap((ageBin, groupIndex) => {
      const groupItems = items.filter((item) => item.ageBin === ageBin);
      const columns = Math.max(1, Math.floor((groupWidth - dims.gap) / step));
      const limit = Math.min(groupItems.length, maxRows * columns);
      const startX = dims.leftPad + groupIndex * groupWidth + (groupWidth - columns * step + dims.gap) / 2;

      return groupItems.slice(0, limit).map((item, index) => {
        const column = index % columns;
        const row = Math.floor(index / columns);
        const y =
          direction === "up"
            ? dims.baselineY - (row + 1) * step - 10
            : dims.baselineY + dims.downGap + row * step;

        return {
          id: item.id,
          x: Math.round(startX + column * step),
          y: Math.round(y),
          size: direction === "up" ? dims.tileSize : dims.artistTileSize,
          opacity: direction === "up" ? 0.96 : 0.9,
          delay: staggerDelay({ groupIndex, row, column, index, mode: "grid" }),
          duration: "720ms"
        };
      });
    });
  }

  function segmentPanLayout(items, dims, activeSegmentIndex, sourceDims) {
    const track = getScrubTrack(dims, activeSegmentIndex);
    const yearDims = sourceDims || getTimelineDimensions("year");
    const sourceLayout = albumSegmentLayout(items, yearDims, { direct: true });
    const sourceGroupWidth = yearDims.usableWidth / yearSegments.length;
    const scale = track.groupWidth / sourceGroupWidth;

    return sourceLayout.map((tile) => {
      const groupIndex = tile.segmentIndex;
      const sourceGroupLeft = yearDims.leftPad + groupIndex * sourceGroupWidth;
      const targetGroupLeft = track.panOffset + groupIndex * track.groupWidth;
      const x = targetGroupLeft + (tile.x - sourceGroupLeft) * scale;
      const y = dims.baselineY + (tile.y - yearDims.baselineY) * scale;

      return {
        id: tile.id,
        x: Math.round(x),
        y: Math.round(y),
        size: Math.round(tile.size * scale),
        opacity: groupIndex === activeSegmentIndex ? 0.98 : 0.34,
        delay: 0,
        duration: "640ms",
        direct: true
      };
    });
  }

  function getScrubTrack(dims, activeSegmentIndex) {
    // 放大系数 ≈ 系数×段数;5 段时 0.58 会到 2.9× 致高段(19-21/22-25)冲顶被截,调小到 ~2.2×
    const groupWidth = dims.usableWidth * (dims.compact ? 0.6 : 0.44);
    // 激活段居中(原来靠左 leftPad,会被左侧 YEAR SWITCH 文案挡住)
    const centerAnchor = dims.width / 2 - groupWidth / 2;

    return {
      groupWidth,
      trackWidth: groupWidth * yearSegments.length,
      panOffset: centerAnchor - activeSegmentIndex * groupWidth
    };
  }

  function staggerDelay({ groupIndex = 0, row = 0, column = 0, index = 0, mode = "grid" }) {
    if (mode === "shelf") {
      return groupIndex * 3 + row * 2 + column * 0.4;
    }

    if (mode === "focus") {
      return row * 6 + column * 2 + (index % 3);
    }

    return groupIndex * 12 + row * 4 + column * 1.5;
  }

  function getTimelineDimensions(moduleKey) {
    const { width, height } = getStageSize();
    const compact = width < 760;
    const leftPad = compact ? 24 : moduleKey === "age" ? 148 : 116;
    const rightPad = compact ? 18 : 52;
    const baselineY =
      moduleKey === "year"
        ? Math.round(height * (compact ? 0.64 : 0.68))
        : moduleKey === "scrub"
          ? Math.round(height * (compact ? 0.78 : 0.82))
          : Math.round(height * (compact ? 0.5 : 0.52));
    const usableWidth = Math.max(260, width - leftPad - rightPad);
    const tileSize = clamp(Math.floor(width / (compact ? 40 : 60)), compact ? 13 : 20, compact ? 18 : 24);
    const segmentTileSize = clamp(Math.floor(width / (compact ? 36 : 56)), compact ? 13 : 19, compact ? 18 : 28);
    const artistTileSize = clamp(tileSize - 1, compact ? 12 : 18, compact ? 17 : 23);
    const panTileSize = clamp(Math.floor(width / (compact ? 27 : 42)), compact ? 18 : 24, compact ? 25 : 34);
    const gap = compact ? 2 : 3;
    const downGap = compact ? 34 : 44;
    const topReserved = compact ? 126 : 116;
    const bottomReserved =
      moduleKey === "year" ? (compact ? 150 : 118) : moduleKey === "scrub" ? (compact ? 72 : 52) : compact ? 150 : 96;

    return {
      width,
      height,
      compact,
      leftPad,
      rightPad,
      usableWidth,
      baselineY,
      tileSize,
      segmentTileSize,
      artistTileSize,
      panTileSize,
      gap,
      downGap,
      topMatrixHeight: Math.max(90, baselineY - topReserved),
      bottomMatrixHeight: Math.max(90, height - baselineY - downGap - bottomReserved),
      leftLabelX: compact ? 18 : 38,
      labelOffset: compact ? 70 : 82,
      axisY: baselineY + (compact ? 13 : 18)
    };
  }

  function createAxisTicks(values, dims) {
    const groupWidth = dims.usableWidth / values.length;

    return values.map((value, index) =>
      createElement("div", `axis-tick ${value === activeScrubYear ? "is-active" : ""}`, {
        style: `
          left:${dims.leftPad + groupWidth * index + groupWidth * 0.5}px;
          top:${dims.baselineY - dims.topMatrixHeight}px;
          height:${dims.topMatrixHeight + dims.bottomMatrixHeight + dims.downGap}px;
        `
      })
    );
  }

  function createSegmentBands(dims, activeIndex = -1) {
    const groupWidth = dims.usableWidth / yearSegments.length;

    return yearSegments.map((segment, index) =>
      createElement("div", `segment-band ${index === activeIndex ? "is-active" : ""}`, {
        style: `
          left:${dims.leftPad + groupWidth * index}px;
          top:${dims.baselineY - dims.topMatrixHeight}px;
          width:${groupWidth}px;
          height:${dims.topMatrixHeight}px;
        `
      })
    );
  }

  function createSegmentDividers(dims) {
    const groupWidth = dims.usableWidth / yearSegments.length;

    return yearSegments.slice(1).map((_, index) =>
      createElement("div", "segment-divider", {
        style: `
          left:${dims.leftPad + groupWidth * (index + 1)}px;
          top:${dims.baselineY - dims.topMatrixHeight}px;
          height:${dims.topMatrixHeight + 24}px;
        `
      })
    );
  }

  function createScrubTrack(dims, track) {
    const zoom = getScrubZoomVars(dims, track);
    // 背后格网高度:按最高段的专辑行数 × scrub 放大倍数算,确保盖住所有专辑(原来固定 topMatrixHeight 太矮,顶部几行会露在格网外)
    const yearDims = getTimelineDimensions("year");
    const yStep = yearDims.segmentTileSize + yearDims.gap;
    const yCols = Math.max(2, Math.floor((yearDims.usableWidth / yearSegments.length - yearDims.gap * 4) / yStep));
    const scl = track.groupWidth / (yearDims.usableWidth / yearSegments.length);
    let maxRows = 0;
    for (const seg of yearSegments) {
      const cnt = mockAlbums.filter((a) => yearInSegment(a.year, seg)).length;
      maxRows = Math.max(maxRows, Math.ceil(cnt / yCols));
    }
    const bandH = Math.max(dims.topMatrixHeight, (maxRows * yStep + 10) * scl + 16);
    const bandTop = dims.baselineY - bandH;
    const scrubTrack = createElement("div", "scrub-track", {
      style: `
        --scrub-pan:${track.panOffset}px;
        --scrub-zoom-x:${zoom.x}px;
        --scrub-zoom-y:${zoom.y}px;
        --scrub-scale:${zoom.scale};
        --scrub-origin-x:${zoom.originX}px;
        --scrub-origin-y:${zoom.originY}px;
      `
    });

    scrubTrack.append(
      createElement("div", "scrub-track-line", {
        style: `left:0; top:${dims.baselineY}px; width:${track.trackWidth}px;`
      }),
      ...yearSegments.map((segment, index) =>
        createElement("div", `segment-band ${index === activeScrubSegmentIndex ? "is-active" : ""}`, {
          attrs: { "data-segment-index": String(index) },
          style: `
            left:${track.groupWidth * index}px;
            top:${bandTop}px;
            width:${track.groupWidth}px;
            height:${bandH}px;
          `
        })
      ),
      ...yearSegments.slice(1).map((_, index) =>
        createElement("div", "segment-divider", {
          style: `
            left:${track.groupWidth * (index + 1)}px;
            top:${bandTop}px;
            height:${bandH + 24}px;
          `
        })
      ),
      ...yearSegments.map((segment, index) =>
        createElement("div", `axis-label year-range-label year-segment is-major ${index === activeScrubSegmentIndex ? "is-active" : ""}`, {
          attrs: { "data-segment-index": String(index) },
          text: segment.label,
          style: `
            left:${track.groupWidth * index}px;
            top:${dims.axisY}px;
            width:${track.groupWidth}px;
          `
        })
      )
    );

    return scrubTrack;
  }

  function applyScrubTrackState(trackElement, dims, track) {
    const zoom = getScrubZoomVars(dims, track);
    trackElement.style.setProperty("--scrub-pan", `${track.panOffset}px`);
    trackElement.style.setProperty("--scrub-zoom-x", `${zoom.x}px`);
    trackElement.style.setProperty("--scrub-zoom-y", `${zoom.y}px`);
    trackElement.style.setProperty("--scrub-scale", String(zoom.scale));
    trackElement.style.setProperty("--scrub-origin-x", `${zoom.originX}px`);
    trackElement.style.setProperty("--scrub-origin-y", `${zoom.originY}px`);
  }

  function getScrubZoomVars(dims, track) {
    if (scrubZoomPhase !== "from-year") {
      return { x: 0, y: 0, scale: 1, originX: dims.leftPad, originY: dims.baselineY };
    }

    const yearDims = getTimelineDimensions("year");
    const yearGroupWidth = yearDims.usableWidth / yearSegments.length;
    const scale = clamp(yearGroupWidth / track.groupWidth, 0.32, 0.72);

    return {
      x: yearDims.leftPad - dims.leftPad,
      y: yearDims.baselineY - dims.baselineY,
      scale,
      originX: dims.leftPad,
      originY: dims.baselineY
    };
  }

  function createAxisLabels(values, dims, { majorValues = [] } = {}) {
    const groupWidth = dims.usableWidth / values.length;

    return values.map((value, index) =>
      createElement("div", `axis-label ${majorValues.includes(value) ? "is-major" : ""}`, {
        text: String(value),
        style: `
          left:${dims.leftPad + groupWidth * index}px;
          top:${dims.axisY}px;
          width:${groupWidth}px;
        `
      })
    );
  }

  function createYearRangeLabels(dims) {
    const yearWidth = dims.usableWidth / yearOrder.length;

    return yearSegments.map((segment) => {
      const startIndex = yearOrder.indexOf(segment.start);
      const span = segment.end - segment.start + 1;

      return createElement("div", "axis-label year-range-label is-major", {
        text: segment.label,
        style: `
          left:${dims.leftPad + startIndex * yearWidth}px;
          top:${dims.axisY}px;
          width:${yearWidth * span}px;
        `
      });
    });
  }

  function yearInSegment(year, segment) {
    return year >= segment.start && year <= segment.end;
  }

  function createTitlePanel(scene) {
    const panel = createElement("aside", `text-panel is-${scene.module}`);
    panel.append(
      createElement("p", "eyebrow", { text: scene.eyebrow }),
      createElement("h2", "", { text: scene.title }),
      createElement("p", "", { text: scene.body })
    );
    return panel;
  }

  function createSceneNote(text, dims) {
    return createElement("div", "scene-note", {
      text,
      style: `left:${dims.leftPad}px; top:${Math.max(76, dims.baselineY - dims.topMatrixHeight - 34)}px;`
    });
  }

  function createSideLabel(text, color, x, y) {
    return createElement("div", "side-label", {
      text,
      style: `left:${x}px; top:${y}px; --accent:${color};`
    });
  }

  function createLegend(items) {
    const legend = createElement("div", "legend");
    legend.append(...items.map(([label, color]) => createLegendItem(label, color)));
    return legend;
  }

  function createLegendItem(label, color) {
    const item = createElement("span", "legend-item", {
      style: `--accent:${color};`
    });
    item.append(createElement("span", "legend-swatch"), document.createTextNode(label));
    return item;
  }

  function getStageSize() {
    const box = stage.getBoundingClientRect();
    return {
      width: Math.max(box.width, window.innerWidth),
      height: Math.max(box.height, window.innerHeight)
    };
  }

  function createElement(tag, className = "", options = {}) {
    const node = document.createElement(tag);

    if (className) {
      node.className = className;
    }

    if (options.text) {
      node.textContent = options.text;
    }

    if (options.style) {
      node.setAttribute("style", options.style);
    }

    if (options.attrs) {
      Object.entries(options.attrs).forEach(([key, value]) => {
        node.setAttribute(key, value);
      });
    }

    return node;
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  // —— 卸载清理:移除监听/观察器/定时器与持久 tile 图层(应对 React 卸载与 StrictMode 双调用)——
  return function destroy() {
    window.removeEventListener("scroll", updateFromScroll);
    window.removeEventListener("resize", updateFromScroll);
    window.removeEventListener("wheel", onWheelSnap);
    if (windowResizeHandler) window.removeEventListener("resize", windowResizeHandler);
    if (resizeObserver) resizeObserver.disconnect();
    cancelAnimationFrame(resizeFrame);
    cancelAnimationFrame(autoRaf);
    window.clearTimeout(scrubZoomTimer);
    window.clearTimeout(ageRevealTimer);
    window.clearTimeout(snapTimer);
    window.clearTimeout(incTraceTimer);
    tileTip.remove();
    linkSvg.remove();
    incrementSvg.remove();
    if (heroDestroy) { heroDestroy(); heroDestroy = null; }
    albumTransition.destroy();
    ageAlbumTransition.destroy();
    artistTransition.destroy();
  };
}
