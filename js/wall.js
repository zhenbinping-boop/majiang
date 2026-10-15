/**
 * wall.js — 主界面「深绿色麻将墙」背景 + 翻牌转场
 *
 * 三件事：
 *   ① 铺墙：按当前（旋转安全的）逻辑视口铺出一面麻将牌墙 —— 每张牌是一个
 *      CSS 3D 双面牌块：牌背＝深绿玉质（纯 CSS），牌面＝tiles.js 的矢量麻将牌
 *      （以 data-URI 背景图复用，34 种各只解码一次，与墙上牌数无关）。
 *   ② 流动：整片网格做**无缝斜向漂移**（位移恰好一个牌距），外加一道缓慢掠过的
 *      高光，让墙面一直在「活」着。
 *   ③ 转场：flipAndZoom() —— 整墙翻牌（由中心向外的涟漪式错峰）后，
 *      整屏由中心向外放大淡出，交棒给牌桌。
 *
 * 坐标安全：所有尺寸取自 offsetWidth/offsetHeight（**布局**尺寸）。
 * 不要用 getBoundingClientRect()：元素被 rotate 后它返回的是屏幕空间盒、
 * 长宽互换，照它排版会让整面墙错轴（历史上踩过这个坑）。
 */
(function (global) {
  'use strict';

  /* ---------- 时间轴（与 style.css 的 --hw-* 变量保持一致） ---------- */
  const FLIP_MS = 560;      // 单张牌翻转时长        → --hw-flip-ms
  const FLIP_GAP = 330;     // 由中心向外的错峰总量  → --hw-flip-gap
  const ZOOM_MS = 720;      // 整屏放大退场时长      → --hw-zoom-ms
  const ZOOM_LEAD = 170;    // 与翻牌尾部重叠，衔接更顺

  const FACE_KINDS = 34;    // 0..33 共 34 种牌面
  const TILE_AR = 60 / 44;  // 牌高 / 牌宽
  const FILL = 0.86;        // 牌宽 / 牌距（其余留作缝隙）
  const ROW_GAP = 1.10;     // 行距 / 牌高（牌墙码得紧凑些）

  const reduceMotion = () =>
    !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);

  /* ---------- 状态 ---------- */
  let rootEl = null;        // #hm-wall
  let gridEl = null;        // #hw-grid
  let homeEl = null;        // #home
  let dirty = false;        // 铺设期间视口变了 → 待重置时重建
  let built = false;

  /* ---------- ① 牌面样式：34 条 data-URI 背景类 ---------- */
  function injectFaceStyles() {
    if (document.getElementById('hw-face-style')) return;
    const rules = [];
    for (let i = 0; i < FACE_KINDS; i++) {
      const svg = global.MJ.tileFaceSVG(i);
      const uri = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      rules.push('.hw-f' + i + '{background-image:url("' + uri + '")}');
    }
    const st = document.createElement('style');
    st.id = 'hw-face-style';
    st.textContent = rules.join('');
    document.head.appendChild(st);
  }

  /* ---------- ② 铺墙 ---------- */
  /** 洗一副 0..33 的「牌池」，打乱后逐张发，保证整面墙分布均匀、各色齐全 */
  function shuffledPool() {
    const a = [];
    for (let i = 0; i < FACE_KINDS; i++) a.push(i);
    for (let i = a.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function rebuild() {
    if (!rootEl || !gridEl) return;

    const W = rootEl.offsetWidth || global.innerWidth || 390;
    const H = rootEl.offsetHeight || global.innerHeight || 844;

    // 牌距：让视口横向大约容纳 13 列左右，码出一面真正的「牌墙」密度
    // （clamp 兜住极窄/极宽屏，牌小到 48px 时字面依然可辨）
    const pitchW = Math.max(48, Math.min(W / 13, 120));
    const tileW = pitchW * FILL;
    const tileH = tileW * TILE_AR;
    const pitchH = tileH * ROW_GAP;

    // 四边各多铺 2 列/行：流动位移恰好一个牌距，于是循环首尾无缝、始终铺满
    const cols = Math.ceil(W / pitchW) + 2;
    const rows = Math.ceil(H / pitchH) + 2;

    gridEl.style.gridTemplateColumns = 'repeat(' + cols + ', ' + pitchW.toFixed(2) + 'px)';
    gridEl.style.gridAutoRows = pitchH.toFixed(2) + 'px';
    gridEl.style.left = (-pitchW).toFixed(2) + 'px';
    gridEl.style.top = (-pitchH).toFixed(2) + 'px';
    gridEl.style.setProperty('--hw-tw', tileW.toFixed(2) + 'px');
    gridEl.style.setProperty('--hw-th', tileH.toFixed(2) + 'px');
    gridEl.style.setProperty('--hw-pw', pitchW.toFixed(2) + 'px');
    gridEl.style.setProperty('--hw-ph', pitchH.toFixed(2) + 'px');

    // 翻牌错峰：由中心向外呈涟漪
    const cx = (cols - 1) / 2, cy = (rows - 1) / 2;
    const maxD = Math.hypot(cx, cy) || 1;

    let pool = shuffledPool();
    const parts = [];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!pool.length) pool = shuffledPool();
        const kind = pool.pop();
        const d = Math.hypot(c - cx, r - cy) / maxD;
        const fd = Math.round(d * FLIP_GAP);
        parts.push(
          '<div class="hw-tile hw-f' + kind + '" style="--fd:' + fd + 'ms">' +
            '<span class="hw-side hw-back"></span>' +
            '<span class="hw-side hw-front"></span>' +
          '</div>'
        );
      }
    }
    gridEl.innerHTML = parts.join('');
    built = true;
  }

  /* ---------- ③ 转场 ---------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /**
   * 翻牌 → 由屏幕中心向外放大淡出。
   * 返回 Promise，resolve 时墙已推近到视野之外，可以安全交班给牌桌。
   */
  async function flipAndZoom() {
    if (!rootEl) return;

    if (reduceMotion()) {
      rootEl.classList.add('is-flip');
      await sleep(140);
      if (homeEl) homeEl.classList.add('entering');
      await sleep(180);
      return;
    }

    rootEl.classList.add('is-flip');                       // 整墙翻牌
    // 等翻牌走到尾声（留出与放大重叠的时间），再启动推近
    await sleep(FLIP_GAP + FLIP_MS - ZOOM_LEAD);
    if (homeEl) homeEl.classList.add('entering');          // 由中心向外放大
    await sleep(ZOOM_MS);
  }

  /** 回到主界面时调用：把墙恢复成「牌背朝上」并清掉转场状态，下次可重放 */
  function reset() {
    if (rootEl) rootEl.classList.remove('is-flip');
    if (homeEl) homeEl.classList.remove('entering');
    // 强制回流：否则移除 class 后立刻再添加，transition 可能不触发
    if (gridEl) void gridEl.offsetWidth;
    if (dirty) { dirty = false; rebuild(); }
  }

  /* ---------- 视口变化 ---------- */
  function bindResize() {
    let t = 0;
    const onResize = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        // 正在翻牌/退场时先标记，等 reset() 再重建，避免打断动画
        if (rootEl && (rootEl.classList.contains('is-flip') ||
                       (homeEl && homeEl.classList.contains('entering')))) {
          dirty = true;
          return;
        }
        rebuild();
      }, 180);
    };
    global.addEventListener('resize', onResize, { passive: true });
    global.addEventListener('orientationchange', onResize, { passive: true });
  }

  /* ---------- 启动 ---------- */
  function init(root) {
    if (!root || !global.MJ) return null;
    rootEl = root;
    gridEl = root.querySelector('.hw-grid');
    homeEl = document.getElementById('home');
    injectFaceStyles();
    rebuild();
    bindResize();
    return api;
  }

  const api = {
    init: init,
    rebuild: rebuild,
    flipAndZoom: flipAndZoom,
    reset: reset,
    get built() { return built; },
    TIMES: { FLIP_MS: FLIP_MS, FLIP_GAP: FLIP_GAP, ZOOM_MS: ZOOM_MS, ZOOM_LEAD: ZOOM_LEAD },
  };

  global.MJWall = api;
})(typeof window !== 'undefined' ? window : globalThis);
