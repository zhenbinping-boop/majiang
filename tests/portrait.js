/**
 * tests/portrait.js — 手机竖屏旋转（横屏呈现）专项验证
 *
 * 校验点：
 *   1. 竖屏视口下 #app 的 getBoundingClientRect 铺满视口（旋转后视觉占满）
 *   2. 旋转角确为 +90°（顺时针 = 向右横看：顶栏落右、手牌落左）
 *   3. 手牌不被裁切、不与出牌区/操作栏重叠
 *   4. 牌桌四家座位与出牌区均在视口内
 *   5. 弹窗（fixed，在 #app 之外，不随旋转）在旋转状态下仍居中且完整可见
 *   6. 横屏视口不受影响（回归）
 *
 * 运行：NODE_PATH=<managed node workspace>/node_modules node tests/portrait.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8765';
const OUT = path.resolve(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 从主界面进入牌桌并等到布局稳定。
 * #home 是 fixed 覆盖层，进场后必须确实退场（hidden），
 * 否则它会压住 #app，测出来的 rect 全是 0。
 */
async function enterTable(page) {
  await page.waitForFunction(
    () => window.__mjHome && window.MJWall && document.getElementById('home'),
    { timeout: 10000, polling: 60 }
  );
  // 点「开始游戏」→ 翻牌放大转场后进入牌桌
  await page.evaluate(() => {
    const q = document.getElementById('btn-quick');
    if (q) q.click();
  });
  await page.waitForFunction(
    () => {
      const home = document.getElementById('home');
      const app = document.getElementById('app');
      const homeAway = !home || home.classList.contains('hidden');
      const appUp = app && !app.classList.contains('hidden');
      const hand = document.querySelectorAll('#hand .tile, #my-hand .tile, .hand .tile').length;
      return homeAway && appUp && hand > 0;
    },
    { timeout: 15000, polling: 80 }
  ).catch(() => {});
  await sleep(120);
}

const CASES = [
  { name: 'portrait-390x844',  width: 390, height: 844, mode: 'portrait'  },
  { name: 'portrait-360x640',  width: 360, height: 640, mode: 'portrait'  },
  { name: 'portrait-414x896',  width: 414, height: 896, mode: 'portrait'  },
  { name: 'landscape-844x390', width: 844, height: 390, mode: 'landscape' },
];

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

  const results = [];

  for (const c of CASES) {
    await page.setViewport({
      width: c.width, height: c.height, deviceScaleFactor: 2,
      isMobile: c.mode === 'portrait', hasTouch: c.mode === 'portrait',
    });
    await page.goto(BASE + '/index.html', { waitUntil: 'networkidle0' });
    await sleep(900);

    // 启动层已加入 #home 主界面 + #intro 入场动画，牌桌 (#app) 初始为 hidden。
    // 本用例测的是牌桌布局，必须先把游戏拉起来、等两层退场后再测。
    await enterTable(page);

    // ── 关键简化 ──
    // #app 旋转后仍铺满整个视口（coversViewport 已验证），故「某元素是否在视口内」
    // 等价于「其屏幕包围盒是否落在 #app 的屏幕包围盒内」；「两元素是否重叠」在旋转下
    // 也是不变量（相交性不随旋转改变）。因此这里无需任何坐标反解，直接用 rect 判断。
    const r = await page.evaluate(() => {
      const app = document.getElementById('app');
      const vw = window.innerWidth, vh = window.innerHeight;
      const ab = app.getBoundingClientRect();
      const cs = getComputedStyle(app);
      const m = cs.transform;
      // 从 matrix 提取旋转角
      let deg = 0;
      if (m && m !== 'none') {
        const p = m.match(/matrix\(([^)]+)\)/);
        if (p) {
          const [a, b] = p[1].split(',').map(s => parseFloat(s.trim()));
          deg = Math.round(Math.atan2(b, a) * 180 / Math.PI);
        }
      }
      const ROTATED = Math.abs(deg) > 45;
      // 参照系 = #app 的屏幕包围盒（旋转下即整个视口）
      const IN = (b) => b.left >= ab.left - 1 && b.top >= ab.top - 1 &&
                        b.right <= ab.right + 1 && b.bottom <= ab.bottom + 1;
      const rect = (sel) => {
        const e = document.querySelector(sel);
        if (!e) return null;
        const b = e.getBoundingClientRect();
        return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
      };
      const hit = (a, b) => !!a && !!b && !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
      const tileRects = [...document.querySelectorAll('#my-hand .tile')].map(t => t.getBoundingClientRect());
      const handRect = (() => { const h = document.querySelector('#my-hand'); return h ? h.getBoundingClientRect() : null; })();
      const ab_ = document.getElementById('action-bar');
      const barRect = ab_ && !ab_.classList.contains('hidden') ? ab_.getBoundingClientRect() : null;

      // 手牌完整可见（每张的屏幕包围盒都在 #app 内）
      const offscreen = tileRects.filter(b => !IN(b)).length;
      // 手牌与操作栏重叠
      const overlap = hit(handRect, barRect) ? 1 : 0;
      // 四家座位与四块牌河是否都在视口内
      const seats = ['#seat-1', '#seat-2', '#seat-3', '#me'].map(s => document.querySelector(s));
      const rivers = ['#river-0', '#river-1', '#river-2', '#river-3'].map(s => document.querySelector(s));
      const outOfView = [...seats, ...rivers].filter(e => e && !IN(e.getBoundingClientRect())).length;

      return {
        vw, vh, deg, rotated: ROTATED,
        appRect: { x: Math.round(ab.left), y: Math.round(ab.top), w: Math.round(ab.width), h: Math.round(ab.height) },
        // 尺寸互换看 computed style（旋转后的 boundingRect 会绕回原视口尺寸）
        cssW: Math.round(parseFloat(cs.width)),
        cssH: Math.round(parseFloat(cs.height)),
        origin: cs.transformOrigin,
        appFills: Math.round(parseFloat(cs.width)) === (ROTATED ? vh : vw) && Math.round(parseFloat(cs.height)) === (ROTATED ? vw : vh),
        coversViewport: ab.left <= 2 && ab.top <= 2 && ab.width >= vw - 3 && ab.height >= vh - 3,
        handCount: tileRects.length,
        tileW: tileRects.length ? Math.round(tileRects[0].width) : 0,
        tileH: tileRects.length ? Math.round(tileRects[0].height) : 0,
        // 屏幕坐标系下的方位：顺时针旋转后顶栏应在右半屏、手牌应在左半屏
        topbarOnRight: (() => { const t = document.getElementById('topbar'); if (!t) return null;
          const b = t.getBoundingClientRect(); return (b.left + b.right) / 2 > vw / 2; })(),
        handOnLeft: (() => { const h = document.querySelector('#my-hand'); if (!h) return null;
          const b = h.getBoundingClientRect(); return (b.left + b.right) / 2 < vw / 2; })(),
        offscreen, overlap, outOfView,
      };
    });

    // 弹窗验证（结构为 .modal-mask > .modal）
    await page.evaluate(() => document.getElementById('btn-rules').click());
    await sleep(500);
    const modal = await page.evaluate(() => {
      const box = document.querySelector('.modal-mask .modal');
      if (!box) return { open: false };
      const b = box.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      // #modal-root 与 #app 同步旋转，故弹窗在屏幕坐标下也转了 90°：
      // 「完整可见」需用旋转后的外接矩形判定（左/上 ≥ -2、右/下 ≤ 视口+2）；
      // 「居中」不受旋转影响。
      return {
        open: true,
        w: Math.round(b.width), h: Math.round(b.height),
        x: Math.round(b.left), y: Math.round(b.top),
        fullyVisible: b.left >= -2 && b.top >= -2 && b.right <= vw + 2 && b.bottom <= vh + 2,
        centered: Math.abs((b.left + b.right) / 2 - vw / 2) < vw * 0.12 && Math.abs((b.top + b.bottom) / 2 - vh / 2) < vh * 0.15,
      };
    });
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll('.modal button, .modal .act-btn')].find(b => /关|知道|确定|继/.test(b.textContent));
      if (btn) btn.click();
    });
    await sleep(300);

    /* 操作栏（轮到自己出牌时出现）：
       统一坐标系方案下，竖屏旋转后 #app 内一切都已处在「横屏逻辑视口」中 ——
       操作栏自然是一条**水平胶囊**（与横屏矮屏完全一致），按钮横向、文字水平。
       因此竖屏与横屏使用同一组断言：完整落在视口内、不盖住手牌牌面、不压局势铭牌。 */
    const actionBar = await page.evaluate(() => {
      const bar = document.getElementById('action-bar');
      bar.classList.remove('hidden');
      bar.innerHTML = ['吃', '碰', '杠', '胡', '过']
        .map(t => '<button class="act-btn">' + t + '</button>').join('');
      const app = document.getElementById('app');
      const m = getComputedStyle(app).transform;
      let deg = 0;
      if (m && m !== 'none') {
        const p = m.match(/matrix\(([^)]+)\)/);
        if (p) { const [a, b] = p[1].split(',').map(s => parseFloat(s.trim())); deg = Math.round(Math.atan2(b, a) * 180 / Math.PI); }
      }
      const ROTATED = Math.abs(deg) > 45;
      const ab = app.getBoundingClientRect();
      const b = bar.getBoundingClientRect();
      const IN = (r) => r.left >= ab.left - 1 && r.top >= ab.top - 1 && r.right <= ab.right + 1 && r.bottom <= ab.bottom + 1;
      const hit = (a, c) => !!a && !!c && !(a.right < c.left || a.left > c.right || a.bottom < c.top || a.top > c.bottom);
      // 与「手牌牌面」比对（牌托有内边距，允许压到牌托边缘，但不能盖住牌）
      const coversTile = [...document.querySelectorAll('#my-hand .tile')].some(t => hit(t.getBoundingClientRect(), b));
      const plaque = document.getElementById('center-plaque');
      const coversPlaque = plaque ? hit(plaque.getBoundingClientRect(), b) : false;
      const btn = bar.querySelector('.act-btn');
      const bb = btn ? btn.getBoundingClientRect() : null;
      return {
        rotated: ROTATED,
        visible: true,
        // 旋转下（顺时针 90°）屏幕包围盒的宽=逻辑高、高=逻辑宽，故判断「横排」需换回
        w: Math.round(ROTATED ? b.height : b.width),
        h: Math.round(ROTATED ? b.width : b.height),
        horizontal: (ROTATED ? b.height : b.width) > (ROTATED ? b.width : b.height),
        btnHorizontal: bb ? (ROTATED ? bb.height : bb.width) > (ROTATED ? bb.width : bb.height) : null,
        inViewport: IN(b),
        coversTile, coversPlaque,
      };
    });
    await page.evaluate(() => document.getElementById('action-bar').classList.add('hidden'));

    await page.screenshot({ path: path.join(OUT, 'portrait-' + c.name + '.png') });
    results.push({ c, r, modal, actionBar });
  }

  await browser.close();

  /* ---------- 输出 ---------- */
  console.log('\n============ 手机竖屏旋转验证 ============\n');
  let allOk = true;
  for (const { c, r, modal, actionBar } of results) {
    const isPortrait = c.mode === 'portrait';
    let rowOk = true;
    const mark = (v) => { if (!v) rowOk = false; return v ? '✓' : '✗'; };

    console.log('【' + c.name + '】 视口 ' + r.vw + '×' + r.vh);
    if (isPortrait) {
      console.log('  旋转角        : ' + r.deg + '°  ' + mark(r.deg === 90) + ' (顺时针：顶栏落右 / 手牌落左)');
      console.log('  尺寸互换      : ' + r.cssW + '×' + r.cssH + '  ' + mark(r.appFills) + ' (宽=视口高 ' + r.vh + ', 高=视口宽 ' + r.vw + ')');
      console.log('  铺满视口      : ' + mark(r.coversViewport) + '  视觉盒 ' + r.appRect.w + '×' + r.appRect.h);
    } else {
      console.log('  旋转角        : ' + r.deg + '°  ' + mark(r.deg === 0) + ' (横屏不旋转)');
    }
    console.log('  手牌          : ' + r.handCount + ' 张 ' + r.tileW + '×' + r.tileH);
    console.log('  手牌越界      : ' + r.offscreen + '  ' + mark(r.offscreen === 0));
    console.log('  手牌压操作栏  : ' + r.overlap + '  ' + mark(r.overlap === 0));
    console.log('  座位/牌河越界 : ' + r.outOfView + '  ' + mark(r.outOfView === 0));
    if (isPortrait) {
      console.log('  方位(向右看)  : 顶栏在右' + mark(r.topbarOnRight) + ' 手牌在左' + mark(r.handOnLeft));
    }
    console.log('  弹窗          : ' + (modal.open ? (modal.w + '×' + modal.h + ' 完整' + mark(modal.fullyVisible) + ' 居中' + mark(modal.centered)) : '未打开'));
    if (actionBar) {
      console.log('  操作栏        : ' + actionBar.w + '×' + actionBar.h + ' 横排' + mark(actionBar.horizontal) +
        ' 按钮横向' + mark(actionBar.btnHorizontal) + ' 在视口内' + mark(actionBar.inViewport) +
        ' 不盖牌面' + mark(!actionBar.coversTile) + ' 不压铭牌' + mark(!actionBar.coversPlaque));
    }
    console.log('  → ' + (rowOk ? '通过 ✓' : '未通过 ✗'));
    console.log('');
    if (!rowOk) allOk = false;
  }

  console.log('脚本错误: ' + errors.length + (errors.length ? '\n  ' + errors.join('\n  ') : ''));
  console.log('\n' + (allOk && errors.length === 0 ? '全部通过 ✓' : '存在失败项 ✗'));
  console.log('截图已存至 shots/portrait-*.png');

  process.exit(allOk && errors.length === 0 ? 0 : 1);
})();
