/**
 * intro.js — 主界面入场动画「洗牌拼标题」
 *
 * 设计思路（只负责排版 + 排期，关键帧全部写在 CSS 里，便于统一调时）：
 *
 *   ① 取一副真麻将的牌面纹样（MJ.glyphSheet），用**一个** SVG + 若干 <use> 铺
 *      出数十张字面 —— 每张字面就是一个 <use>，CSS 可以逐个驱动它。
 *   ② 每张字面配三条几何信息：
 *        · 起点（F）：视口四边之外随机一处，带随机偏转角与缩放（飞入感）
 *        · 洗牌点（T）：屏幕中央一个很小的圆盘内（聚成一堆乱牌）
 *        · 落点（D）：均匀铺在整屏的网格上（散成一片，随后整体淡出）
 *      起点/洗牌点/落点用相对画布中心（50% 50%）的 px 偏移表达，
 *      <use> 自身的 x/y 已经把它摆到了落点，故 transform 里的 D 偏移即 (0,0)。
 *   ③ 时间轴（CSS 变量，与 style.css 的 --t-* 一致）：
 *        A 0.05–(--t-shuffle)  从四方飞入 + 翻转，边飞边向中央收拢
 *        B 到 --t-settle       中央牌堆「啪」地一顿
 *        C --t-rise 起         每张字面「立」向落位；同时散雾亮起，标题开始显现
 *        D 标题四字 + 副标语依次落定
 *        E --t-end             动画层淡出，交给主界面
 *
 *   全程不阻塞启动：动画层是 #home 之上的覆盖层，下面的主界面早已渲染完毕，
 *   动画淡出即可交互；点击「跳过」或 3.2s 兜底计时器都会立刻结束。
 *   尊重 prefers-reduced-motion（见 style.css）。
 */
(function (global) {
  'use strict';

  /* 与 style.css 的 :root 时间变量一一对应，改这里即可整体调时 */
  const T = {
    shuffle: 1400,   // A→B 飞入 + 洗牌成堆 + 一顿（单张字面第一段）
    settle: 1400,    // B 收束完成时刻 = 第二段起点（须 = shuffle）
    riseDur: 950,    // C→D 字面「立」向落位并淡出
    rise: 1750,      // C 标题开始显现
    end: 2750,       // E 动画层整体淡出、主界面接棒
    hard: 3250,      // 兜底：无论如何在此时刻彻底结束
  };

  /* 字面数量：手机少一些（性能 + 呼吸感），桌面多一些（气势） */
  const COUNT_WIDE = 46;
  const COUNT_NARROW = 34;

  /* 候选取样：万/筒/条各取若干 + 全部字牌，保证一眼是「一副麻将」 */
  const POOL = [
    0, 1, 2, 3, 4, 5, 6, 7, 8,     // 一万~九万
    9, 10, 11, 12, 13, 15, 17,     // 一筒~九筒
    18, 19, 20, 21, 22, 24, 26,    // 一条~九条
    27, 28, 29, 30, 31, 32, 33,    // 东南西北中发白
  ];

  /* 牌面固有宽高比（见 tiles.js 的 VW/VH = 44:60） */
  const AR = 44 / 60;

  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[(Math.random() * arr.length) | 0];

  /**
   * 洗牌拼标题。
   * @param {HTMLElement} root   #intro 容器
   * @param {Object} [opts]
   * @param {Function} [opts.onDone] 动画结束（含被跳过）时回调，只调用一次
   * @returns {{ skip: Function }} 外部可主动结束
   */
  function run(root, opts) {
    opts = opts || {};
    const done = typeof opts.onDone === 'function' ? opts.onDone : function () {};

    let finished = false;
    let timers = [];
    const later = (fn, ms) => { timers.push(setTimeout(fn, ms)); };
    const clearAll = () => { timers.forEach(clearTimeout); timers = []; };

    // 关掉旧动画，避免重复触发时叠加
    clearAll();
    run._cleanup && run._cleanup();
    run._cleanup = null;

    if (!root) { done(); return { skip: function () {} }; }

    /* ---------- 0. 尊重「减弱动态效果」：只做一次淡出 ---------- */
    const reduce = global.matchMedia
      && global.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if (reduce) {
      root.classList.remove('gone');
      root.classList.add('leaving');
      const fin = () => { root.classList.add('gone'); done(); };
      const t = setTimeout(fin, 460);
      run._cleanup = () => clearTimeout(t);
      return { skip: fin };
    }

    /* ---------- 1. 排版 ---------- */
    const host = root.querySelector('#intro-tiles');
    if (!host) { done(); return { skip: function () {} }; }

    /* 关键：手机竖屏下 #intro 与 #app 一样整体旋转 90°，getBoundingClientRect()
       返回的是**屏幕空间**的盒子（长宽互换），而 #intro 内部的 SVG 活在
       **旋转后的逻辑坐标系**里。两者混用会让排版宽高颠倒 —— 字面会被铺到错误的
       方向上，看起来像「没跟着转」。
       故这里一律用 offsetWidth/offsetHeight 取「布局尺寸」（不受 transform 影响），
       它就是逻辑视口尺寸，与 CSS 的 --vw/--vh 一致。 */
    const W = root.offsetWidth || global.innerWidth || 390;
    const H = root.offsetHeight || global.innerHeight || 844;
    // 逻辑视口长边（用于判断「宽屏」，与是否旋转无关）
    const wide = Math.max(W, H) >= 760;

    const n = wide ? COUNT_WIDE : COUNT_NARROW;
    // 字面尺寸：以「整屏网格能铺下 n 张」为约束，再取一个舒服的视觉尺寸
    const cols = Math.round(Math.sqrt(n * (W / H)));
    const rows = Math.ceil(n / cols);
    const cellW = W / cols, cellH = H / rows;
    const gw = Math.max(16, Math.min(cellW * 0.94, cellH * AR * 0.94));
    const gh = gw / AR;

    // 散落网格：每张字面认领一格，格内加一点随机抖动，避免像贴瓷砖
    const cells = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cells.push([r, c]);
    // 洗牌：保证落点分布随机而不是按行列顺序
    for (let i = cells.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = cells[i]; cells[i] = cells[j]; cells[j] = t;
    }

    // 洗牌堆半径：中央一个小圆盘，尽量挤
    const pileR = Math.min(W, H) * 0.075;

    const ids = [];
    const pieces = [];
    for (let i = 0; i < n; i++) {
      const [r, c] = cells[i % cells.length];
      // 落点（相对中心的偏移）
      const cx = (c + 0.5) * cellW - W / 2 + rand(-cellW * 0.06, cellW * 0.06);
      const cy = (r + 0.5) * cellH - H / 2 + rand(-cellH * 0.06, cellH * 0.06);
      // 洗牌点：中央圆盘内随机
      const a = Math.random() * Math.PI * 2;
      const rad = Math.sqrt(Math.random()) * pileR;
      const sx = Math.cos(a) * rad;
      const sy = Math.sin(a) * rad;
      // 起点：从视口四边之外飞入。
      // 先定方向，再把「画布半宽/半高的对角」投到该方向上，得到一个必然在
      // 视口之外的距离 —— 否则「上/下」边一旦横向偏得远，加起来可能又落回屏内。
      const ang = Math.random() * Math.PI * 2;
      const ux2 = Math.cos(ang), uy2 = Math.sin(ang);
      const halfDiag = Math.hypot(W, H) / 2;
      const dOut = (halfDiag + Math.max(gw, gh) * 0.6) * rand(1.0, 1.12);
      let fx = ux2 * dOut, fy = uy2 * dOut;

      ids.push(pick(POOL));
      pieces.push({
        // <use> 自身坐标：把它摆到落点（SVG 用户单位 = CSS px，因为 width/height=100%）
        ux: W / 2 + cx - gw / 2,
        uy: H / 2 + cy - gh / 2,
        // 三段位移（相对自身当前位置）
        fx: fx - cx, fy: fy - cy, fr: rand(-200, 200),
        sx: sx - cx, sy: sy - cy, sr: rand(-64, 64),
        // 洗牌时的缩放（从大飞入 → 聚拢变小）
        fs: rand(1.4, 2.1), ss: rand(0.42, 0.72),
        // 「立」向落位后轻微缩小淡出
        ds: rand(0.8, 0.94),
        delay: rand(0.04, 0.3).toFixed(3),
      });
    }

    // 一份 defs + 若干 <use>：比「每张字面一个 SVG」省掉上百份重复的渐变定义
    const sheet = global.MJ.glyphSheet(ids);
    host.innerHTML =
      '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' + global.MJ.defs() + sheet.defs + '</defs>' +
      '<g>' + pieces.map((p, i) =>
        '<use class="it" xlink:href="#ig-' + i + '" href="#ig-' + i + '"' +
        ' x="' + p.ux.toFixed(2) + '" y="' + p.uy.toFixed(2) + '"' +
        ' width="' + gw.toFixed(2) + '" height="' + gh.toFixed(2) + '"' +
        ' style="' +
        '--fx:' + p.fx.toFixed(1) + 'px;--fy:' + p.fy.toFixed(1) + 'px;--fr:' + p.fr.toFixed(0) + 'deg;' +
        '--fs:' + p.fs.toFixed(2) + ';' +
        '--tx:' + p.sx.toFixed(1) + 'px;--ty:' + p.sy.toFixed(1) + 'px;--tr:' + p.sr.toFixed(0) + 'deg;' +
        '--tc:' + p.ss.toFixed(2) + ';' +
        '--dx:0px;--dy:0px;--dc:' + p.ds.toFixed(2) + ';' +
        '--it-delay:' + p.delay + 's' +
        '"/>').join('') + '</g></svg>';

    /* ---------- 2. 排期 ---------- */
    // 单张字面的两段动画完全由 CSS 关键帧驱动（见 style.css 的 it-shuffle / it-rise）。
    // 时间常量以 JS 的 T 为唯一真源，这里把它们写回 :root 的 --t-* 变量，
    // 避免「JS 改了一个时长、CSS 忘了同步」这类漂移。
    const rs = document.documentElement.style;
    rs.setProperty('--t-shuffle', (T.shuffle / 1000) + 's');
    rs.setProperty('--t-settle', (T.settle / 1000) + 's');
    rs.setProperty('--t-rise-d', (T.riseDur / 1000) + 's');
    rs.setProperty('--t-rise', (T.rise / 1000) + 's');
    rs.setProperty('--t-end', (T.end / 1000) + 's');

    root.classList.remove('gone', 'leaving');

    /* ---------- 3. 收尾 ---------- */
    const finish = () => {
      if (finished) return;
      finished = true;
      clearAll();
      root.classList.add('leaving');
      later(() => {
        root.classList.add('gone');
        if (host) host.innerHTML = '';   // 释放那几十个 <use>
        done();
      }, 430);
    };

    later(finish, T.end);
    later(() => { if (!finished) finish(); }, T.hard);

    const skipBtn = root.querySelector('#intro-skip');
    const onSkip = (e) => {
      if (e) { e.preventDefault(); e.stopPropagation(); }
      finish();
    };
    if (skipBtn) skipBtn.addEventListener('click', onSkip);

    run._cleanup = () => {
      clearAll();
      if (skipBtn) skipBtn.removeEventListener('click', onSkip);
      root.classList.add('gone');
      if (host) host.innerHTML = '';
    };

    return { skip: finish, times: T };
  }

  global.MJIntro = { run: run, TIMES: T };
})(typeof window !== 'undefined' ? window : this);
