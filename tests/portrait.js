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
      const rect = (sel) => {
        const e = document.querySelector(sel);
        if (!e) return null;
        const b = e.getBoundingClientRect();
        return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) };
      };
      const tiles = [...document.querySelectorAll('#my-hand .tile')].map(t => t.getBoundingClientRect());
      const hand = document.querySelector('#my-hand');
      const handRect = hand ? hand.getBoundingClientRect() : null;
      const ab_ = document.getElementById('action-bar');
      const abRect = ab_ && !ab_.classList.contains('hidden') ? ab_.getBoundingClientRect() : null;

      // 手牌完整可见（每张都落在视口内）
      const offscreen = tiles.filter(t => t.left < -1 || t.top < -1 || t.right > vw + 1 || t.bottom > vh + 1).length;
      // 手牌与操作栏重叠
      let overlap = 0;
      if (handRect && abRect) {
        overlap = !(handRect.right < abRect.left || handRect.left > abRect.right ||
                    handRect.bottom < abRect.top || handRect.top > abRect.bottom) ? 1 : 0;
      }
      // 四家座位与四块牌河是否都在视口内
      const seats = ['#seat-1', '#seat-2', '#seat-3', '#me'].map(s => rect(s));
      const rivers = ['#river-0', '#river-1', '#river-2', '#river-3'].map(s => rect(s));
      const outOfView = [...seats, ...rivers].filter(b => b && (b.x < -2 || b.y < -2 || b.x + b.w > vw + 2 || b.y + b.h > vh + 2)).length;

      return {
        vw, vh, deg,
        appRect: { x: Math.round(ab.left), y: Math.round(ab.top), w: Math.round(ab.width), h: Math.round(ab.height) },
        // 尺寸互换看 computed style（旋转后的 boundingRect 会绕回原视口尺寸）
        cssW: Math.round(parseFloat(cs.width)),
        cssH: Math.round(parseFloat(cs.height)),
        origin: cs.transformOrigin,
        appFills: Math.round(parseFloat(cs.width)) === vh && Math.round(parseFloat(cs.height)) === vw,
        coversViewport: ab.left <= 2 && ab.top <= 2 && ab.width >= vw - 3 && ab.height >= vh - 3,
        handCount: tiles.length,
        tileW: tiles.length ? Math.round(tiles[0].width) : 0,
        tileH: tiles.length ? Math.round(tiles[0].height) : 0,
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
       · 竖屏（整屏旋转）下刻意做成「竖直胶囊」：容器竖排 (h > w)，但每个按钮仍横向
         (w > h) 以保证文字水平可读 —— 这样它能塞进手牌与牌河之间的竖缝，不压铭牌。
       · 横屏下是普通的水平横排胶囊。
       两种形态都必须：完整落在视口内、不盖住手牌牌面、不压局势铭牌。 */
    const actionBar = await page.evaluate(() => {
      const bar = document.getElementById('action-bar');
      bar.classList.remove('hidden');
      bar.innerHTML = ['吃', '碰', '杠', '胡', '过']
        .map(t => '<button class="act-btn">' + t + '</button>').join('');
      const b = bar.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      // 与「手牌牌面」比对（牌托有内边距，允许压到牌托边缘，但不能盖住牌）
      const coversTile = [...document.querySelectorAll('#my-hand .tile')].some(t => {
        const r = t.getBoundingClientRect();
        return !(r.right < b.left || r.left > b.right || r.bottom < b.top || r.top > b.bottom);
      });
      const plaque = document.getElementById('center-plaque');
      const pb = plaque ? plaque.getBoundingClientRect() : null;
      const coversPlaque = pb
        ? !(b.right < pb.left || b.left > pb.right || b.bottom < pb.top || b.top > pb.bottom)
        : false;
      const btn = bar.querySelector('.act-btn');
      const bb = btn ? btn.getBoundingClientRect() : null;
      return {
        visible: true,
        w: Math.round(b.width), h: Math.round(b.height),
        vertical: b.height > b.width,                    // 竖屏下应为竖直胶囊
        horizontal: b.width > b.height,                  // 横屏下应为横排
        btnHorizontal: bb ? bb.width > bb.height : null, // 按钮横向 = 文字水平可读
        inViewport: b.left >= -1 && b.top >= -1 && b.right <= vw + 1 && b.bottom <= vh + 1,
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
      if (isPortrait) {
        console.log('  操作栏        : ' + actionBar.w + '×' + actionBar.h + ' 竖排' + mark(actionBar.vertical) +
          ' 按钮横向' + mark(actionBar.btnHorizontal) + ' 在视口内' + mark(actionBar.inViewport) +
          ' 不盖牌面' + mark(!actionBar.coversTile) + ' 不压铭牌' + mark(!actionBar.coversPlaque));
      } else {
        console.log('  操作栏        : ' + actionBar.w + '×' + actionBar.h + ' 横排' + mark(actionBar.horizontal) +
          ' 在视口内' + mark(actionBar.inViewport) + ' 不盖牌面' + mark(!actionBar.coversTile));
      }
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
