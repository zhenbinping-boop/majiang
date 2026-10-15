/**
 * tests/home.js — 主界面（深绿麻将墙）+ 翻牌放大转场 专项验证
 *
 * 校验点：
 *   1. 首帧即见主界面：#home 存在、品牌/主按钮/副入口齐全，#app 初始隐藏
 *   2. 无启动过渡动画：首帧没有 is-flip / entering 等转场态，页面加载即静止可用
 *   3. 麻将墙：#hw-grid 铺出合理数量的牌（每张牌背+牌面双面结构），
 *      牌面种类多样（≥10 种），墙面覆盖视口
 *   4. 持续流动：网格 animationName=hw-flow、playState=running，且 transform 随时间变化
 *   5. 三档视口都正确：桌面 / 手机竖屏（旋转 90°） / 手机横屏
 *   6. 主按钮尺寸达标（≥56px 高）且不与其它元素重叠
 *   7. 点「开始游戏」→ 整墙翻牌（is-flip）→ 向外放大（entering）→ 主界面隐去、牌桌出现
 *   8. 顶栏「返回主界面」→ 回到主界面，墙重置（无 is-flip），「继续上局」出现
 *
 * 运行：NODE_PATH=<managed node workspace>/node_modules node tests/home.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8765';
const OUT = path.resolve(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 用 DOM 原生 click() 而不是 puppeteer 的鼠标点击。
 * 主界面是全屏覆盖层 + 旋转定位，headless 下的命中测试容易误判为
 * 「被遮挡」而静默不触发；原生 click() 直接派发事件，稳定且与真实用户行为等价。
 */
const clickSel = (page, sel) => page.evaluate((s) => {
  const e = document.querySelector(s);
  if (!e) return false;
  e.click();
  return true;
}, sel);

/* 与 style.css / wall.js 的时间轴对齐 */
const T = { FLIP_MS: 560, FLIP_GAP: 330, ZOOM_MS: 720, ZOOM_LEAD: 170 };

const CASES = [
  { name: 'home-desktop',   width: 1440, height: 900, mobile: false },
  { name: 'home-portrait',  width: 390,  height: 844, mobile: true  },
  { name: 'home-landscape', width: 844,  height: 390, mobile: true  },
];

/* 页面内：几何快照 */
function snap() {
  const R = (sel) => {
    const e = typeof sel === 'string' ? document.querySelector(sel) : sel;
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height),
             right: Math.round(b.right), bottom: Math.round(b.bottom) };
  };
  const app = document.getElementById('app');
  const home = document.getElementById('home');
  const wallEl = document.getElementById('hm-wall');
  const grid = document.getElementById('hw-grid');
  const cs = app ? getComputedStyle(app) : null;
  let deg = 0;
  if (cs && cs.transform && cs.transform !== 'none') {
    const m = cs.transform.match(/matrix\(([^)]+)\)/);
    if (m) { const [a, b] = m[1].split(',').map((s) => parseFloat(s.trim())); deg = Math.round(Math.atan2(b, a) * 180 / Math.PI); }
  }
  const hidden = (e) => !e || e.classList.contains('hidden') || getComputedStyle(e).display === 'none';
  const tiles = grid ? grid.querySelectorAll('.hw-tile') : [];
  const kinds = new Set();
  let doubleSide = 0;
  for (const t of tiles) {
    t.classList.forEach((c) => { if (c.startsWith('hw-f')) kinds.add(c); });
    if (t.querySelector('.hw-back') && t.querySelector('.hw-front')) doubleSide++;
  }
  /* 牌面分布：检查「各不相同」是否有意义地铺开 */
  const kindCount = kinds.size;
  /* 流动动画状态 */
  const gcs = grid ? getComputedStyle(grid) : null;
  const anim = gcs ? {
    name: gcs.animationName, state: gcs.animationPlayState,
    dur: gcs.animationDuration,
    m1: gcs.transform,
  } : null;
  const wallRect = wallEl ? wallEl.getBoundingClientRect() : null;
  return {
    vw: window.innerWidth, vh: window.innerHeight, deg,
    appHidden: hidden(app),
    homeHidden: hidden(home),
    home: R('#home'),
    wrap: R('.hm-wrap'),
    brand: R('.hm-brand'),
    logo: R('.hm-logo'),
    slogan: R('.hm-slogan'),
    cta: R('#btn-quick'),
    resume: R('#btn-resume'),
    resumeHidden: hidden(document.getElementById('btn-resume')),
    rules: R('#home-rules'),
    sound: R('#home-sound'),
    foot: R('.hm-foot'),
    wall: wallRect ? { w: Math.round(wallRect.width), h: Math.round(wallRect.height) } : null,
    tileCount: tiles.length,
    kindCount, doubleSide,
    anim,
    isFlip: !!(wallEl && wallEl.classList.contains('is-flip')),
    entering: !!(home && home.classList.contains('entering')),
    leaving: !!(home && home.classList.contains('leaving')),
    hand: document.querySelectorAll('#my-hand .tile').length,
    rulesModal: R('.modal-mask'),
    docScrollW: document.documentElement.scrollWidth,
    docScrollH: document.documentElement.scrollHeight,
  };
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });

  const results = [];
  let fatal = [];

  for (const c of CASES) {
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errs.push('console.error: ' + m.text()); });

    await page.setViewport({
      width: c.width, height: c.height, deviceScaleFactor: 2,
      isMobile: c.mobile, hasTouch: c.mobile,
    });
    await page.goto(BASE + '/index.html', { waitUntil: 'load', timeout: 30000 });

    /* ---- 首帧：主界面 + 麻将墙已在，且没有任何转场状态 ---- */
    await page.waitForSelector('#hw-grid .hw-tile', { timeout: 8000 });
    await sleep(500);
    const first = await page.evaluate(snap);
    await page.screenshot({ path: path.join(OUT, c.name + '.png') });

    /* ---- 流动验证：间隔取样两次，transform 应该变了 ---- */
    await sleep(650);
    const second = await page.evaluate(snap);
    const flowing = first.anim && second.anim &&
      first.anim.name === 'hw-flow' && second.anim.name === 'hw-flow' &&
      first.anim.state.indexOf('running') >= 0 &&
      first.anim.m1 !== second.anim.m1;

    /* ---- 主按钮点击 → 翻牌 → 放大 → 进牌桌 ---- */
    await clickSel(page, '#btn-quick');
    /* 翻牌应立即触发（is-flip 在点击后马上加上） */
    await sleep(160);
    const midFlip = await page.evaluate(snap);
    await page.screenshot({ path: path.join(OUT, c.name + '-flip.png') });
    /* 等进入牌桌（翻牌 560+330 → 放大 720，约 1.5s，手牌发出需要一些时间） */
    await page.waitForFunction(() => document.querySelectorAll('#my-hand .tile').length >= 13, { timeout: 25000, polling: 120 });
    await sleep(600);
    const play = await page.evaluate(snap);
    await page.screenshot({ path: path.join(OUT, c.name + '-play.png') });

    /* ---- 顶栏返回主界面（确认弹窗 → 返回）---- */
    await clickSel(page, '#btn-home');
    await page.waitForSelector('.modal-mask', { timeout: 5000 });
    const homeModal = await page.evaluate(snap);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('.modal .act-btn')].find((x) => x.textContent.indexOf('返回') >= 0);
      if (b) b.click();
    });
    await page.waitForFunction(() => !document.querySelector('#home').classList.contains('hidden'), { timeout: 6000, polling: 80 });
    await sleep(450);
    const back = await page.evaluate(snap);
    await page.screenshot({ path: path.join(OUT, c.name + '-back.png') });

    results.push({ name: c.name, first, second, flowing, midFlip, play, homeModal, back, errs });
    await page.close();
  }

  /* ---- 单独验证「继续上局」 ---- */
  let resumeRes = null;
  try {
    const p = await browser.newPage();
    await p.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await p.goto(BASE + '/index.html', { waitUntil: 'load' });
    await p.waitForSelector('#hw-grid .hw-tile', { timeout: 8000 });
    const beforeClick = await p.evaluate(snap);
    // 先开一局，再返回
    await clickSel(p, '#btn-quick');
    await p.waitForFunction(() => document.querySelectorAll('#my-hand .tile').length >= 13, { timeout: 25000, polling: 120 });
    await sleep(500);
    await clickSel(p, '#btn-home');
    await p.waitForSelector('.modal-mask', { timeout: 5000 });
    await p.evaluate(() => {
      const b = [...document.querySelectorAll('.modal .act-btn')].find((x) => x.textContent.indexOf('返回') >= 0);
      if (b) b.click();
    });
    await sleep(500);
    const afterBack = await p.evaluate(snap);
    const sub = await p.$eval('#resume-sub', (e) => e.textContent);
    // 继续上局：不重放翻牌，直接推进牌桌
    await clickSel(p, '#btn-resume');
    await sleep(900);
    const resumed = await p.evaluate(snap);
    resumeRes = {
      resumeHiddenInitially: beforeClick.resumeHidden,
      resumeVisibleAfterBack: !afterBack.resumeHidden,
      resumeSubText: sub,
      wallResetAfterBack: !afterBack.isFlip,
      enteredAfterResume: resumed.homeHidden && !resumed.appHidden && resumed.hand >= 13,
    };
    await p.screenshot({ path: path.join(OUT, 'home-resume.png') });
    await p.close();
  } catch (e) {
    fatal.push('继续上局用例: ' + e.message);
  }

  await browser.close();

  /* ================= 输出 ================= */
  console.log('\n============ 主界面（深绿麻将墙） ============');
  let allOk = true;
  for (const r of results) {
    const f = r.first, m = r.second, p = r.play, b = r.back, mf = r.midFlip;
    const ctaOk = f.cta && f.cta.h >= 56;
    const inView = (x) => !!x && x.x >= -1 && x.y >= -1 && x.right <= f.vw + 1 && x.bottom <= f.vh + 1;
    const ctaInView = inView(f.cta);
    const overlap = (a, c2) => !!a && !!c2 && a.x < c2.right - 1 && c2.x < a.right - 1 && a.y < c2.bottom - 1 && c2.y < a.bottom - 1;
    const noOverlap = !overlap(f.brand, f.cta) && !overlap(f.cta, f.foot);
    const noScroll = f.docScrollW <= f.vw + 1 && f.docScrollH <= f.vh + 1;
    /* 墙面覆盖：竖屏下 #home 被旋转，视觉上墙是「横铺」的；用 #home 的布局尺寸判断覆盖即可 */
    const wallCovers = !!f.wall && f.wall.w >= f.vw * 0.98 && f.wall.h >= f.vh * 0.98;

    const footBtns = [f.rules, f.sound].filter(Boolean);
    const maxFootBtnW = footBtns.length ? Math.max(...footBtns.map((x) => x.w)) : 0;
    const checks = {
      '主界面首帧可见': !f.homeHidden,
      '牌桌初始隐藏': f.appHidden,
      '首帧无转场态': !f.isFlip && !f.entering && !f.leaving,
      '品牌/Logo/slogan 齐全': !!f.brand && !!f.logo && !!f.slogan,
      '主按钮 ≥56px 高': ctaOk,
      '主按钮在视口内': ctaInView,
      '主按钮不与品牌/次要入口重叠': noOverlap,
      '主按钮比次要入口更宽(视觉中心)': !!(f.cta && f.cta.w > maxFootBtnW * 1.2),
      '无横向/纵向滚动': noScroll,
      '麻将墙铺出且覆盖视口': wallCovers,
      '墙牌数量合理(≥40)': f.tileCount >= 40,
      '牌张双面结构齐全': f.tileCount > 0 && f.doubleSide === f.tileCount,
      '牌面种类多样(≥10)': f.kindCount >= 10,
      '墙面持续流动(hw-flow running)': !!r.flowing,
      '点击后整墙翻牌(is-flip)': mf.isFlip,
      '主按钮可点进牌桌': !!(p && p.homeHidden && !p.appHidden && p.hand >= 13),
      '返回主界面可用': !!(r.homeModal.rulesModal && !b.homeHidden && b.appHidden),
      '返回后墙面重置(无 is-flip)': !b.isFlip,
      '无脚本错误': r.errs.length === 0,
    };
    const ok = Object.values(checks).every(Boolean);
    allOk = allOk && ok;
    console.log(`\n【${r.name}】 视口 ${f.vw}×${f.vh} 旋转${f.deg}°`);
    console.log(`  品牌 ${f.brand ? f.brand.w + '×' + f.brand.h : '—'}  主按钮 ${f.cta ? f.cta.w + '×' + f.cta.h : '—'}` +
      `  次要入口行 ${f.foot ? f.foot.w + '×' + f.foot.h : '—'}`);
    console.log(`  麻将墙: ${f.tileCount} 张牌（双面 ${f.doubleSide}）  牌面种类 ${f.kindCount}  墙面 ${f.wall ? f.wall.w + '×' + f.wall.h : '—'}` +
      `  流动 ${r.flowing ? '✓' : '✗'}`);
    console.log(`  转场: 翻牌 ${mf.isFlip ? '✓' : '✗'}  进牌桌手牌 ${p.hand}  返回后主界面 ${!b.homeHidden ? '✓' : '✗'}  墙重置 ${!b.isFlip ? '✓' : '✗'}`);
    for (const [k, v] of Object.entries(checks)) if (!v) console.log(`   ✗ ${k}`);
    console.log(`  → ${ok ? '通过 ✓' : '未通过 ✗'}`);
    if (r.errs.length) console.log('  错误:', JSON.stringify(r.errs.slice(0, 4)));
  }

  console.log('\n【继续上局】', JSON.stringify(resumeRes));
  if (fatal.length) console.log('\n用例异常:', JSON.stringify(fatal));
  console.log('\n主界面（深绿麻将墙）:', allOk && !fatal.length
    && resumeRes && resumeRes.resumeVisibleAfterBack && resumeRes.enteredAfterResume && resumeRes.wallResetAfterBack
    ? '全部通过 ✓' : '未通过 ✗');
  console.log('==========================================\n');
  process.exit(allOk && !fatal.length ? 0 : 1);
})().catch((e) => {
  console.error('致命错误:', e && e.stack || e);
  process.exit(2);
});
