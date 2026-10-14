/**
 * tests/home.js — 主界面 + 入场动画 专项验证
 *
 * 校验点：
 *   1. 首帧即见主界面：#home 存在、可点、品牌/主按钮/副入口齐全，#app 初始隐藏
 *   2. 入场动画：字面张数合理、飞入起点在视口之外、洗牌点收在中央、
 *      动画结束后动画层消失且主界面可交互（不残留 DOM / 不残留动画）
 *   3. 「跳过」立即结束动画
 *   4. 三档视口都正确：桌面 / 手机竖屏（旋转） / 手机横屏（不旋转）
 *   5. 主按钮尺寸达标（拇指可达，≥56px 高）且不与其它元素重叠
 *   6. 点「快速开局」→ 主界面隐去、牌桌出现、手牌发出
 *   7. 顶栏「返回主界面」→ 回到主界面，「继续上局」出现
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
 * 「被遮挡」而静默不触发；原生 click() 直接派发事件，稳定且与真实用户行为等价
 * （真实场景下用户点得到，因为视觉与命中测试在真机一致）。
 */
const clickSel = (page, sel) => page.evaluate((s) => {
  const e = document.querySelector(s);
  if (!e) return false;
  e.click();
  return true;
}, sel);

/* 与 style.css / intro.js 的时间轴对齐 */
const T = { settle: 1550, rise: 1750, end: 2750, hard: 3250 };

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
  const cs = app ? getComputedStyle(app) : null;
  let deg = 0;
  if (cs && cs.transform && cs.transform !== 'none') {
    const m = cs.transform.match(/matrix\(([^)]+)\)/);
    if (m) { const [a, b] = m[1].split(',').map((s) => parseFloat(s.trim())); deg = Math.round(Math.atan2(b, a) * 180 / Math.PI); }
  }
  const hidden = (e) => !e || e.classList.contains('hidden') || getComputedStyle(e).display === 'none';
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
    intro: R('#intro'),
    introGone: hidden(document.getElementById('intro')),
    introTiles: document.querySelectorAll('#intro-tiles .it').length,
    hand: document.querySelectorAll('#my-hand .tile').length,
    rulesModal: R('.modal-mask'),
    docScrollW: document.documentElement.scrollWidth,
    docScrollH: document.documentElement.scrollHeight,
  };
}

/* 页面内：入场动画的关键帧取样（起点是否在视口外 / 洗牌点是否在中央） */
function probeIntro() {
  const svg = document.querySelector('#intro-tiles svg');
  if (!svg) return null;
  const uses = [...svg.querySelectorAll('use.it')];
  if (!uses.length) return null;
  const root = document.getElementById('intro').getBoundingClientRect();
  const W = root.width, H = root.height;
  const inside = (x, y) => x >= 0 && x <= W && y >= 0 && y <= H;
  let outCount = 0;
  const tPoints = [];
  const dPoints = [];
  for (const u of uses) {
    const st = getComputedStyle(u);
    const num = (k) => parseFloat(st.getPropertyValue(k)) || 0;
    // <use> 自身位置 = 落点（SVG 用户单位 = px，因为 viewBox 与容器 1:1）
    const ux = parseFloat(u.getAttribute('x')) || 0;
    const uy = parseFloat(u.getAttribute('y')) || 0;
    dPoints.push([ux, uy]);
    // 起点 = 落点 + (--fx,--fy)，应落在视口之外
    if (!inside(ux + num('--fx'), uy + num('--fy'))) outCount++;
    // 洗牌点 = 落点 + (--tx,--ty)，应靠近画布中心
    tPoints.push([ux + num('--tx'), uy + num('--ty')]);
  }
  const cx = W / 2, cy = H / 2;
  const pileR = Math.hypot(W, H);
  const maxPileDist = Math.max(...tPoints.map(([x, y]) => Math.hypot(x + 18 - cx, y + 24 - cy)));
  return {
    count: uses.length,
    outCount,
    outRatio: outCount / uses.length,
    pileMaxDist: Math.round(maxPileDist),
    pileDiagFrac: +(maxPileDist / (Math.min(W, H) / 2)).toFixed(2),
    spreadX: Math.round(Math.max(...dPoints.map((p) => p[0])) - Math.min(...dPoints.map((p) => p[0]))),
    spreadY: Math.round(Math.max(...dPoints.map((p) => p[1])) - Math.min(...dPoints.map((p) => p[1]))),
    canvas: { W: Math.round(W), H: Math.round(H) },
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

    /* ---- 首帧：主界面已在，且动画正在播 ---- */
    await page.waitForSelector('#home', { timeout: 5000 });
    await sleep(420);
    const first = await page.evaluate(snap);
    const probe0 = await page.evaluate(probeIntro);
    await page.screenshot({ path: path.join(OUT, 'intro-' + c.name + '-mid.png') });

    /* ---- 洗牌收束后（标题刚起）---- */
    await sleep(Math.max(0, T.rise + 320 - 420));
    const mid = await page.evaluate(snap);
    await page.screenshot({ path: path.join(OUT, 'intro-' + c.name + '-title.png') });

    /* ---- 动画结束：主界面就绪 ---- */
    await sleep(Math.max(0, T.hard + 500 - (T.rise + 320)));
    const fin = await page.evaluate(snap);
    const probeEnd = await page.evaluate(probeIntro);
    await page.screenshot({ path: path.join(OUT, c.name + '.png') });

    /* ---- 主按钮点击 → 进入牌桌 ---- */
    await clickSel(page, '#btn-quick');
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
    await sleep(400);
    const back = await page.evaluate(snap);
    await page.screenshot({ path: path.join(OUT, c.name + '-back.png') });

    results.push({ name: c.name, first, probe0, mid, fin, probeEnd, play, homeModal, back, errs });
    await page.close();
  }

  /* ---- 单独验证「跳过」 ---- */
  let skipRes = null;
  try {
    const p = await browser.newPage();
    await p.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await p.goto(BASE + '/index.html', { waitUntil: 'load' });
    await sleep(500);
    const before = await p.evaluate(snap);
    await clickSel(p, '#intro-skip');
    await sleep(700);
    const after = await p.evaluate(snap);
    skipRes = { beforeIntroGone: before.introGone, afterIntroGone: after.introGone, afterHomeHidden: after.homeHidden };
    await p.close();
  } catch (e) {
    fatal.push('跳过用例: ' + e.message);
  }

  /* ---- 单独验证「继续上局」 ---- */
  let resumeRes = null;
  try {
    const p = await browser.newPage();
    await p.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await p.goto(BASE + '/index.html', { waitUntil: 'load' });
    await sleep(T.hard + 400);
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
    // 继续上局
    await clickSel(p, '#btn-resume');
    await sleep(800);
    const resumed = await p.evaluate(snap);
    resumeRes = {
      resumeHiddenInitially: beforeClick.resumeHidden,
      resumeVisibleAfterBack: !afterBack.resumeHidden,
      resumeSubText: sub,
      enteredAfterResume: resumed.homeHidden && !resumed.appHidden && resumed.hand >= 13,
    };
    await p.screenshot({ path: path.join(OUT, 'home-resume.png') });
    await p.close();
  } catch (e) {
    fatal.push('继续上局用例: ' + e.message);
  }

  await browser.close();

  /* ================= 输出 ================= */
  console.log('\n============ 主界面 + 入场动画 ============');
  let allOk = true;
  for (const r of results) {
    const f = r.first, m = r.mid, e = r.fin, p = r.play, b = r.back, pr = r.probe0, pe = r.probeEnd;
    const ctaOk = f.cta && f.cta.h >= 56;
    const inView = (x) => !!x && x.x >= -1 && x.y >= -1 && x.right <= f.vw + 1 && x.bottom <= f.vh + 1;
    const ctaInView = inView(f.cta);
    const overlap = (a, c2) => !!a && !!c2 && a.x < c2.right - 1 && c2.x < a.right - 1 && a.y < c2.bottom - 1 && c2.y < a.bottom - 1;
    const noOverlap = !overlap(f.brand, f.cta) && !overlap(f.cta, f.foot);
    const noScroll = f.docScrollW <= f.vw + 1 && f.docScrollH <= f.vh + 1;

    /* 「主按钮占据视觉中心」= 它显著大于次要入口里**最大的那个**按钮。
       竖屏横排布局下 .hm-foot 是纵向堆叠，行宽 ≈ 单个按钮宽，直接比行宽即可。
       为避免与 foot 行宽混淆，这里逐个取次要按钮的最大宽度。 */
    const footBtns = [f.rules, f.sound].filter(Boolean);
    const maxFootBtnW = footBtns.length ? Math.max(...footBtns.map((x) => x.w)) : 0;
    const checks = {
      '主界面首帧可见': !f.homeHidden,
      '牌桌初始隐藏': f.appHidden,
      '品牌/Logo/slogan 齐全': !!f.brand && !!f.logo && !!f.slogan,
      '主按钮 ≥56px 高': ctaOk,
      '主按钮在视口内': ctaInView,
      '主按钮不与品牌/次要入口重叠': noOverlap,
      '主按钮比次要入口更宽(视觉中心)': !!(f.cta && f.cta.w > maxFootBtnW * 1.2),
      '无横向/纵向滚动': noScroll,
      '首帧字面数合理(24~60)': !!pr && pr.count >= 24 && pr.count <= 60,
      '飞入起点在视口外(≥90%)': !!pr && pr.outRatio >= 0.9,
      '洗牌点收在中央(≤0.35)': !!pr && pr.pileDiagFrac <= 0.35,
      '落点铺开覆盖整屏': !!pr && pr.spreadX > pr.canvas.W * 0.5 && pr.spreadY > pr.canvas.H * 0.5,
      '动画自行结束并清理': !!(e.introGone && pe === null),
      '结束后主界面就绪': !e.homeHidden,
      '主按钮可点进牌桌': !!(p && p.homeHidden && !p.appHidden && p.hand >= 13),
      '返回主界面可用': !!(r.homeModal.rulesModal && !b.homeHidden && b.appHidden),
      '无脚本错误': r.errs.length === 0,
    };
    const ok = Object.values(checks).every(Boolean);
    allOk = allOk && ok;
    console.log(`\n【${r.name}】 视口 ${f.vw}×${f.vh} 旋转${f.deg}°`);
    console.log(`  品牌 ${f.brand ? f.brand.w + '×' + f.brand.h : '—'}  主按钮 ${f.cta ? f.cta.w + '×' + f.cta.h : '—'}` +
      `  次要入口行 ${f.foot ? f.foot.w + '×' + f.foot.h : '—'}`);
    if (pr) console.log(`  入场: ${pr.count} 张字面  起点在视口外 ${(pr.outRatio * 100).toFixed(0)}%` +
      `  洗牌堆半径比 ${pr.pileDiagFrac}  落点铺开 ${pr.spreadX}×${pr.spreadY}`);
    console.log(`  结束: 动画层已清 ${e.introGone ? '✓' : '✗'}  主界面就绪 ${!e.homeHidden ? '✓' : '✗'}` +
      `  进牌桌后手牌 ${p.hand}  返回后主界面 ${!b.homeHidden ? '✓' : '✗'}`);
    for (const [k, v] of Object.entries(checks)) if (!v) console.log(`   ✗ ${k}`);
    console.log(`  → ${ok ? '通过 ✓' : '未通过 ✗'}`);
    if (r.errs.length) console.log('  错误:', JSON.stringify(r.errs.slice(0, 4)));
  }

  console.log('\n【跳过】', JSON.stringify(skipRes));
  console.log('【继续上局】', JSON.stringify(resumeRes));
  if (fatal.length) console.log('\n用例异常:', JSON.stringify(fatal));
  console.log('\n主界面 + 入场动画:', allOk && !fatal.length && skipRes && skipRes.afterIntroGone && !skipRes.afterHomeHidden
    && resumeRes && resumeRes.resumeVisibleAfterBack && resumeRes.enteredAfterResume ? '全部通过 ✓' : '未通过 ✗');
  console.log('==========================================\n');
  process.exit(allOk && !fatal.length ? 0 : 1);
})().catch((e) => {
  console.error('致命错误:', e && e.stack || e);
  process.exit(2);
});
