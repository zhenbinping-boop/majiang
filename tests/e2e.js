/**
 * tests/e2e.js — 浏览器端端到端测试（puppeteer-core 驱动本机 Chrome）
 *
 * 覆盖：
 *   A. 多视口渲染：桌面 / 手机竖屏 / 手机横屏 / 平板 —— 检查横向溢出、关键元素存在、截图存档
 *   B. 真实交互：点击手牌出牌（选中→出牌）、AI 自动行动、牌山消耗、牌河增长
 *   C. 弹窗：玩法规则开/关、重新开局确认弹窗的取消分支
 *
 * 运行（需要本地静态服务器在 127.0.0.1:8765，根目录为 mahjong/）：
 *   NODE_PATH=<managed node workspace>/node_modules node tests/e2e.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8765';
const OUT = path.resolve(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const report = { consoleErrors: [], consoleWarnings: [], pageErrors: [], requestsFailed: [], viewports: [], interaction: {}, errors: [] };
const shot = (name) => path.join(OUT, name + '.png');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 启动层是 #home 主界面（深绿麻将墙背景）；#app 牌桌初始 hidden。
 * 所有针对牌桌的用例都必须先经此函数进场。
 * 返回 Promise，resolve 表示已进牌桌且 #home 均已退场。
 */
async function enterTable(page, timeout = 20000) {
  await page.waitForFunction(
    () => window.__mjHome && document.getElementById('home') && document.getElementById('btn-quick'),
    { timeout, polling: 60 }
  );
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
      return homeAway && appUp;
    },
    { timeout, polling: 80 }
  ).catch(() => {});
}

/* ---------- 视口配置 ---------- */
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900, dsf: 1 },
  { name: 'laptop', width: 1280, height: 720, dsf: 1 },
  { name: 'tablet', width: 820, height: 1180, dsf: 1 },
  { name: 'mobile', width: 390, height: 844, dsf: 2, isMobile: true, hasTouch: true },
  { name: 'mobile-landscape', width: 844, height: 390, dsf: 2, isMobile: true, hasTouch: true },
];

/* ---------- 页面内度量 ---------- */
/* 手机竖屏时 #app 整体顺时针旋转 90°（向右横看）呈现横屏，其子元素的
   getBoundingClientRect 落在「旋转后的屏幕坐标系」里，与竖屏视口的长宽轴相反 ——
   直接用它们做溢出 / 碰撞 / 行数判断会全部失真（手牌在屏幕空间变成竖排，
   于是被误判成 14 行、座位面板被误判压住手牌）。
   这里把 #app 内部的度量统一换算回 #app 的**自身坐标系**（未旋转的本地坐标），
   使全部几何断言与旋转无关，桌面 / 手机横屏 / 手机竖屏走同一套逻辑。

   顺时针映射（transform-origin: 0 0，transform = translateX(W) rotate(90deg)）：
     局部 (lx, ly) → 屏幕 (appLeft + appW - ly, appTop + lx)
   反解：
     lx = screenY - appTop
     ly = appLeft + appW - screenX                                */
function measure() {
  const app = document.getElementById('app');
  const d3 = window.__mjTable3d;
  const IS3D = !!(d3 && d3.is3D);
  const t3dDbg = (window.__mahjong && window.__mahjong.ui && window.__mahjong.ui.t3d)
    ? window.__mahjong.ui.t3d.debug() : null;
  const ROTATED = (() => {
    const cs = getComputedStyle(app);
    const m = cs.transform;
    if (!m || m === 'none') return false;
    const p = m.match(/matrix\(([^)]+)\)/);
    if (!p) return false;
    // 有旋转分量（b !== 0）且旋转角接近 ±90° 才算「整屏旋转」
    const [a, b] = p[1].split(',').map(s => parseFloat(s.trim()));
    return Math.abs(b) > 0.5 && Math.abs(a) < 0.5;
  })();
  const appRect = app.getBoundingClientRect();
  // 旋转布局下：#app 局部「宽」= 屏幕高(appRect.height)、局部「高」= 屏幕宽(appRect.width)
  //   顺时针：lx = screenY - appRect.top，ly = (appRect.left + appRect.width) - screenX
  // 非旋转布局：直接减去 appRect 的左上角即可。
  const offX = ROTATED ? appRect.top : appRect.left;
  const offY = ROTATED ? (appRect.left + appRect.width) : appRect.top;
  // 屏幕坐标 → #app 本地坐标
  const toLocal = (bx, by, bw, bh) => ROTATED
    ? { x: by - offX, y: offY - bx - bw, w: bh, h: bw }
    : { x: bx - offX, y: by - offY, w: bw, h: bh };
  const r = (sel) => {
    const e = document.querySelector(sel); if (!e) return null;
    const b = e.getBoundingClientRect();
    return { ...toLocal(b.left, b.top, b.width, b.height), _r: b };
  };
  const box = (el) => { const b = el.getBoundingClientRect(); return toLocal(b.left, b.top, b.width, b.height); };
  const cnt = (sel) => document.querySelectorAll(sel).length;
  const hand = document.querySelector('#my-hand .tile');
  const overlap = (a, b) => !!a && !!b && a.x + a.w > b.x + 1 && b.x + b.w > a.x + 1 && a.y + a.h > b.y + 1 && b.y + b.h > a.y + 1;
  // 旋转后的 #app 本地坐标系尺寸：宽 = 屏幕高，高 = 屏幕宽
  const VW = ROTATED ? Math.round(appRect.height) : window.innerWidth;
  const VH = ROTATED ? Math.round(appRect.width) : window.innerHeight;
  // #app 本地内容是否溢出（旋转下 scrollW/scrollH 也会互换）
  const rawSW = document.documentElement.scrollWidth, rawSH = document.documentElement.scrollHeight;
  const locSW = ROTATED ? rawSH : rawSW, locSH = ROTATED ? rawSW : rawSH;
  return {
    is3D: IS3D,
    rotated: ROTATED,
    vw: VW, vh: VH,
    screenVw: window.innerWidth, screenVh: window.innerHeight,
    scrollW: locSW, scrollH: locSH,
    overflowX: locSW > VW + 1,
    overflowY: locSH > VH + 1,
    /* 3D 模式：牌块在 WebGL 场景内，DOM 几何断言不适用（由 tests/table3d.js 专项覆盖） */
    tileBox: null, riverTileBox: null,
    riverBare: IS3D ? true : (() => {
      const els = [...document.querySelectorAll('#rivers .river')];
      if (!els.length) return null;
      return els.every(e => {
        const s = getComputedStyle(e);
        const bg = s.backgroundColor;
        return (bg === 'rgba(0, 0, 0, 0)' || bg === 'transparent')
          && parseFloat(s.borderTopWidth) === 0
          && parseFloat(s.borderBottomWidth) === 0
          && s.boxShadow === 'none'
          && (s.maskImage === 'none' || !s.maskImage)
          && (s.webkitMaskImage === 'none' || !s.webkitMaskImage);
      });
    })(),
    cursorFit: IS3D ? true : (() => {
      const c = document.querySelector('#rivers .river .tile.cursor');
      if (!c) return null;
      const b = c.getBoundingClientRect(), p = c.parentElement.getBoundingClientRect();
      return b.top >= p.top - 1 && b.left >= p.left - 1 && b.right <= p.right + 1 && b.bottom <= p.bottom + 1;
    })(),
    el: {
      topbar: r('#topbar'), table: r('#table'), seatTop: r('#seat-2'), seatLeft: r('#seat-3'),
      seatRight: r('#seat-1'), myPanel: r('#me-panel'), myHand: r('#my-hand'),
      center: r('#center'), rivers: r('#rivers'), plaque: r('#center-plaque'),
      r0: r('#river-0'), r1: r('#river-1'), r2: r('#river-2'), r3: r('#river-3'),
      panelTop: r('#panel-2'), panelLeft: r('#panel-3'), panelRight: r('#panel-1'),
    },
    /* 3D 模式：碰撞与适配由相机自动取景保证（tests/table3d.js 截图专项复核） */
    collide: IS3D ? { riversOverlap: false, left: false, right: false, top: false } : (() => {
      const { r0, r1, r2, r3, rivers, panelLeft, panelRight, panelTop } = {
        r0: r('#river-0'), r1: r('#river-1'), r2: r('#river-2'), r3: r('#river-3'),
        rivers: r('#rivers'), panelLeft: r('#panel-3'), panelRight: r('#panel-1'), panelTop: r('#panel-2'),
      };
      const pairs = [[r2, r0], [r3, r1], [r2, r3], [r2, r1], [r0, r3], [r0, r1]];
      return {
        riversOverlap: pairs.some(([a, b]) => overlap(a, b)),
        left: !!rivers && !!panelLeft && panelLeft.x + panelLeft.w > rivers.x + 1,
        right: !!rivers && !!panelRight && panelRight.x < rivers.x + rivers.w - 1,
        top: !!rivers && !!panelTop && panelTop.y + panelTop.h > rivers.y + 1,
      };
    })(),
    /* 纵向适配：body 有 overflow:hidden，溢出不会被 scrollHeight 发现，必须逐区块测底边。
       本地坐标下 VH 即旋转前视口高（竖屏时 = 屏幕宽）。 */
    fit: IS3D ? { handBottom: VH, handInView: true, handNotOverflow: true, seatsInView: true, topAboveRiver: true, riversInCenter: true } : (() => {
      const hand = r('#my-hand'), pl = r('#panel-3'), pr = r('#panel-1'), pt = r('#panel-2');
      const center = r('#center'), rivers = r('#rivers');
      if (!hand) return null;
      // 牌河是否超出中央区（含 1px 容差）
      const riversInCenter = (!center || !rivers) ? true
        : (rivers.y >= center.y - 1 && rivers.y + rivers.h <= center.y + center.h + 1
          && rivers.x >= center.x - 1 && rivers.x + rivers.w <= center.x + center.w + 1);
      return {
        handBottom: hand.y + hand.h,
        handInView: hand.y + hand.h <= VH + 1,
        handNotOverflow: hand.w <= VW - 8,
        seatsInView: (!pl || pl.y + pl.h <= VH + 1) && (!pr || pr.y + pr.h <= VH + 1),
        topAboveRiver: (!pt || !rivers) ? true : pt.y + pt.h <= rivers.y + 1,
        riversInCenter,
      };
    })(),
    /* 手牌行数：窄屏折成两行以放大牌面；宽屏必须保持单行。（3D 模式为场景立牌，恒单行） */
    handRows: IS3D ? 1 : (() => {
      const els = [...document.querySelectorAll('#my-hand .tile')];
      if (!els.length) return 0;
      return new Set(els.map(e => Math.round(box(e).y))).size;
    })(),
    counts: IS3D ? {
      myHand: d3.handCount(0),
      myMelds: d3.meldCount(0),
      riverTotal: [0, 1, 2, 3].reduce((s, pid) => s + (t3dDbg ? t3dDbg.riverCount(pid) : 0), 0),
      r0: t3dDbg ? t3dDbg.riverCount(0) : 0,
      r1: t3dDbg ? t3dDbg.riverCount(1) : 0,
      r2: t3dDbg ? t3dDbg.riverCount(2) : 0,
      r3: t3dDbg ? t3dDbg.riverCount(3) : 0,
      cursor: ((window.__mahjong.engine.lastDiscarder) >= 0 ? 1 : 0),
      cursorInMyRiver: (window.__mahjong.engine.lastDiscarder === 0 ? 1 : 0),
      seat1: d3.handCount(1), seat2: d3.handCount(2), seat3: d3.handCount(3),
    } : {
      myHand: cnt('#my-hand .tile'),
      myMelds: cnt('#my-melds .tile'),
      riverTotal: cnt('#rivers .river .tile'),
      r0: cnt('#river-0 .tile'), r1: cnt('#river-1 .tile'), r2: cnt('#river-2 .tile'), r3: cnt('#river-3 .tile'),
      cursor: cnt('#rivers .river .tile.cursor'),
      cursorInMyRiver: cnt('#river-0 .tile.cursor'),
      seat1: cnt('#seat-1 .tile'), seat2: cnt('#seat-2 .tile'), seat3: cnt('#seat-3 .tile'),
    },
    /* 牌河张数必须逐一等于各玩家 discards 的长度（数据 ↔ 渲染对照） */
    riverMatch: (() => {
      const ui = window.__mahjong && window.__mahjong.ui;
      if (!ui) return null;
      const ps = ui.engine.players;
      if (IS3D && t3dDbg) {
        return [0, 1, 2, 3].every(pid => t3dDbg.riverCount(pid) === ps[pid].discards.length);
      }
      return [0, 1, 2, 3].every(pid => cnt('#river-' + pid + ' .tile') === ps[pid].discards.length);
    })(),
    round: document.getElementById('round-name').textContent,
    wall: document.getElementById('wall-count').textContent,
    banner: document.getElementById('turn-banner').textContent,
  };
}

/* 页面内：等待「人类可出牌」条件（3D 与 DOM 两种渲染路径通吃） */
const HAND_READY = `(() => {
  const d3 = window.__mjTable3d;
  if (d3 && d3.is3D) return d3.handCount(0) >= 13;
  return document.querySelectorAll('#my-hand .tile').length >= 13;
})()`;

/* ---------- 通用：等待轮到人类出牌（期间自动处理鸣牌询问） ---------- */
async function waitHumanDiscard(page, prompts, timeout = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const st = await page.evaluate(() => {
      const d3 = window.__mjTable3d;
      const is3D = !!(d3 && d3.is3D);
      const bar = document.getElementById('action-bar');
      const barVisible = !!bar && !bar.classList.contains('hidden');
      return {
        barVisible,
        btns: barVisible ? [...bar.querySelectorAll('.act-btn')].map(b => b.textContent.trim()) : [],
        melds: is3D ? d3.meldCount(0) : document.querySelectorAll('#my-melds .meld').length,
        hand: is3D ? d3.handCount(0) : document.querySelectorAll('#my-hand .tile').length,
        banner: (document.getElementById('turn-banner') || {}).textContent || '',
      };
    });
    if (st.barVisible) {
      // 鸣牌询问：点「过」（同时验证「过」按钮可用）
      const clicked = await page.evaluate(() => {
        const bar = document.getElementById('action-bar');
        const btn = [...bar.querySelectorAll('.act-btn')].find(b => b.textContent.indexOf('过') >= 0);
        if (btn) { btn.click(); return true; }
        return false;
      });
      if (clicked) { prompts.push(st.btns.join('/')); await sleep(300); continue; }
    }
    const expect = 13 - 3 * st.melds + 1;   // 轮到出牌时应持有的张数
    if (st.banner.indexOf('点击手牌') >= 0 && st.hand === expect) return st;
    await sleep(110);
  }
  throw new Error('等待人类出牌超时');
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu',
      '--autoplay-policy=no-user-gesture-required', '--mute-audio',
      '--disable-features=Translate,BackForwardCache', '--hide-scrollbars'],
  });

  /* ============ A. 多视口渲染 ============ */
  for (const vp of VIEWPORTS) {
    const page = await browser.newPage();
    const errs = [];
    page.on('console', (m) => {
      const t = m.text();
      if (m.type() === 'error') { errs.push('error: ' + t); report.consoleErrors.push(`[${vp.name}] ${t}`); }
      else if (m.type() === 'warning') { report.consoleWarnings.push(`[${vp.name}] ${t}`); }
    });
    page.on('pageerror', (e) => { errs.push('pageerror: ' + e.message); report.pageErrors.push(`[${vp.name}] ${e.message}`); });
    page.on('requestfailed', (r) => report.requestsFailed.push(`[${vp.name}] ${r.url()} ${r.failure() && r.failure().errorText}`));

    await page.setViewport({ width: vp.width, height: vp.height, deviceScaleFactor: vp.dsf || 1, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch });
    await page.goto(BASE + '/index.html', { waitUntil: 'load', timeout: 30000 });
    await enterTable(page);
    await page.waitForFunction(HAND_READY, { timeout: 20000, polling: 100 });
    await sleep(1200);   // 等发牌动画 + 布局稳定

    const m = await page.evaluate(measure);
    m.viewport = vp.name;
    m.errors = errs.slice(0, 5);
    report.viewports.push(m);
    await page.screenshot({ path: shot('vp-' + vp.name), fullPage: false });
    await page.close();
  }

  /* ============ B. 真实交互 ============ */
  const page = await browser.newPage();
  page.on('pageerror', (e) => report.pageErrors.push(`[interaction] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') report.consoleErrors.push(`[interaction] ${m.text()}`); });
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });
  await enterTable(page);
  await page.waitForFunction(HAND_READY, { timeout: 20000 });

  /* 埋点：统计吃/碰/胡音效与浮字被真实调用的情况 */
  await page.evaluate(() => {
    const ui = window.__mahjong.ui;
    window.__sfx = { chi: 0, pong: 0, win: 0, deal: 0, flash: [] };
    ['chi', 'pong', 'win', 'deal'].forEach(k => {
      const orig = ui.sound[k].bind(ui.sound);
      ui.sound[k] = () => { window.__sfx[k]++; return orig(); };
    });
    // 浮字不走 JS 覆写（易被实例方法遮蔽），改在 DOM 层观测 class 变化，结果更可靠
    const el = document.getElementById('action-flash');
    if (el) {
      new MutationObserver(() => {
        if (el.classList.contains('show')) window.__sfx.flash.push(el.textContent + '(' + el.className + ')');
      }).observe(el, { attributes: true, attributeFilter: ['class'] });
    }
  });

  const steps = [];
  const prompts = [];
  const ROUNDS = 6;
  for (let i = 0; i < ROUNDS; i++) {
    try {
      await waitHumanDiscard(page, prompts);
      const before = await page.evaluate(measure);
      // 第一击：选中（3D 走调试接口与真实射线回调同路径；DOM 直接点最后一张）
      const clickLast = () => page.evaluate(() => {
        const d3 = window.__mjTable3d;
        if (d3 && d3.is3D) return d3.clickHandTile(d3.handCount(0) - 1);
        const els = document.querySelectorAll('#my-hand .tile');
        const el = els[els.length - 1];
        if (!el) return false;
        el.click();
        return true;
      });
      await clickLast();
      const selected = await page.evaluate(() => {
        const ui = window.__mahjong.ui;
        if (ui.t3d) return ui.selectedIdx >= 0 ? 1 : 0;
        return document.querySelectorAll('#my-hand .tile.selected').length;
      });
      // 第二击：出牌
      await clickLast();
      await page.waitForFunction((n) => {
        const d3 = window.__mjTable3d;
        const h = (d3 && d3.is3D) ? d3.handCount(0) : document.querySelectorAll('#my-hand .tile').length;
        return h !== n;
      }, { timeout: 15000, polling: 80 }, before.counts.myHand);
      await sleep(400);
      const after = await page.evaluate(measure);
      steps.push({
        round: i + 1,
        selected: selected === 1,
        handBefore: before.counts.myHand, handAfter: after.counts.myHand,
        riverBefore: before.counts.riverTotal, riverAfter: after.counts.riverTotal,
        myRiverBefore: before.counts.r0, myRiverAfter: after.counts.r0,
        cursorMine: after.counts.cursorInMyRiver === 1,
        wallBefore: before.wall, wallAfter: after.wall,
        roundName: before.round,
      });
      if (i === 2) await page.screenshot({ path: shot('play-mid') });
    } catch (e) {
      report.errors.push(`第 ${i + 1} 次出牌失败: ${e.message}`);
      break;
    }
  }
  report.interaction.discardSteps = steps;
  report.interaction.claimPrompts = prompts;
  await page.screenshot({ path: shot('play-final') });

  /* -- 动效规范：普通重渲染不得重复播放「新牌位移」，且最多一张牌带新牌标记 -- */
  try {
    const is3DAnim = await page.evaluate(() => !!(window.__mjTable3d && window.__mjTable3d.is3D));
    const anim = is3DAnim ? null : await page.evaluate(() => {   // 3D：入场由场景补间负责，DOM 动画断言不适用
      const ui = window.__mahjong.ui;
      const before = document.querySelectorAll('#my-hand .tile.just-drawn').length;
      ui.renderMyHand();                        // 模拟一次常规重渲染
      const after = document.querySelectorAll('#my-hand .tile.just-drawn').length;
      const all = [...document.querySelectorAll('#my-hand .tile')];
      const running = all.filter(e => e.getAnimations && e.getAnimations().some(a => a.playState === 'running')).length;
      ui.renderAll();                           // 再来一次全量重渲染
      const running2 = [...document.querySelectorAll('#my-hand .tile')]
        .filter(e => e.getAnimations && e.getAnimations().some(a => a.playState === 'running')).length;
      const lastDrawn = document.querySelectorAll('#my-hand .tile.last-drawn').length;
      return { before, after, running, running2, lastDrawn, hand: all.length };
    });
    report.interaction.animSpec = anim;
  } catch (e) { report.errors.push('动效规范检查: ' + e.message); }

  /* -- 音效：吃/碰/杠/胡 四个独立音效 + 女声喊牌接口必须存在且可安全触发 -- */
  try {
    report.interaction.sfx = await page.evaluate(() => {
      const s = window.__mahjong.ui.sound;
      const names = ['chi', 'pong', 'kong', 'win', 'deal', 'clack', 'thud', 'tick', 'speak', 'pickFemaleVoice'];
      const missing = names.filter(n => typeof s[n] !== 'function');
      let err = null;
      try { ['chi', 'pong', 'kong', 'win', 'deal', 'clack', 'thud', 'tick'].forEach(n => s[n]()); } catch (e) { err = String(e); }
      let spoke = null, voiceErr = null;
      try { spoke = s.speak('碰'); } catch (e) { voiceErr = String(e); }
      const hasSpeech = typeof window.speechSynthesis !== 'undefined';
      return { missing, err, spoke, voiceErr, hasSpeech, hasCtx: !!s.ctx, state: s.ctx ? s.ctx.state : null };
    });
  } catch (e) { report.errors.push('音效检查: ' + e.message); }

  /* -- 动效+音效同步：真实对局中吃/碰/杠被调用过，且浮字与音效同一入口触发 -- */
  try {
    report.interaction.sfxOrganic = await page.evaluate(() => window.__sfx);
    report.interaction.sfxSync = await page.evaluate(async () => {
      const ui = window.__mahjong.ui;
      const before = window.__sfx.chi;
      ui.animateClaim(1, 'chi');
      const el = document.getElementById('action-flash');
      const shown = el.classList.contains('show');
      const text = el.textContent;
      return { chiDelta: window.__sfx.chi - before, shown, text };
    });
  } catch (e) { report.errors.push('音效同步检查: ' + e.message); }

  /* -- 四家独立牌河：DOM 张数 ⇄ 各玩家 discards 数据必须一致，且最多一个悬浮光标 -- */
  try {
    report.interaction.rivers = await page.evaluate(async () => {
      const ui = window.__mahjong.ui;
      const eng = ui.engine;
      const d3 = window.__mjTable3d;
      const is3D = !!(d3 && d3.is3D);
      if (is3D) {
        // 等待所有出牌飞行落桌（pending 清空），最多 2s，再同步计数
        const t3d = ui.t3d;
        for (let i = 0; i < 40 && t3d.debug().pendingCount() > 0; i++) {
          await new Promise(r => setTimeout(r, 50));
        }
        ui.renderRivers({ animate: false });
        const dbg = ui.t3d.debug();
        const per = [0, 1, 2, 3].map(pid => ({
          dom: dbg.riverCount(pid),
          data: eng.players[pid].discards.length,
        }));
        return {
          per,
          match: per.every(x => x.dom === x.data),
          total: per.reduce((a, x) => a + x.dom, 0),
          cursor: eng.lastDiscarder >= 0 ? 1 : 0,
          distinct: true,   // 3D 牌河按座位几何分区，不会重叠
        };
      }
      ui.renderRivers({ animate: false });
      const cnt = (s) => document.querySelectorAll(s).length;
      const per = [0, 1, 2, 3].map(pid => ({
        dom: cnt('#river-' + pid + ' .tile'),
        data: eng.players[pid].discards.length,
      }));
      return {
        per,
        match: per.every(x => x.dom === x.data),
        total: cnt('#rivers .river .tile'),
        cursor: cnt('#rivers .river .tile.cursor'),
        // 两两牌河不得重叠
        distinct: [0, 1, 2, 3].every(pid => {
          const el = document.getElementById('river-' + pid);
          if (!el) return false;
          const b = el.getBoundingClientRect();
          return b.width > 0 && b.height > 0;
        }),
      };
    });
  } catch (e) { report.errors.push('牌河检查: ' + e.message); }

  /* -- 已出过的牌：必须放大到接近手牌、且所在的出牌区不得越界或互相叠压 -- */
  try {
    const is3DGeom = await page.evaluate(() => !!(window.__mjTable3d && window.__mjTable3d.is3D));
    report.interaction.riverGeom = is3DGeom ? null   // 3D：牌块几何由场景管理，DOM 断言不适用
      : (await page.evaluate(() => {
      const R = (e) => { const b = e.getBoundingClientRect(); return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
      const t = document.querySelector('#rivers .river .tile');
      const hand = document.querySelector('#my-hand .tile');
      const box = document.getElementById('rivers').getBoundingClientRect();
      const rs = [...document.querySelectorAll('#rivers .river')].map(R);
      const outside = rs.filter(r => r.x < box.left - 1 || r.x + r.w > box.right + 1 || r.y < box.top - 1 || r.y + r.h > box.bottom + 1).length;
      const ov = (a, b) => a.x + a.w > b.x + 1 && b.x + b.w > a.x + 1 && a.y + a.h > b.y + 1 && b.y + b.h > a.y + 1;
      let overl = 0;
      for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) if (ov(rs[i], rs[j])) overl++;
      return {
        riverTile: t ? R(t) : null, handTile: hand ? R(hand) : null,
        rivers: rs.length, outside, overl,
        bg: t ? getComputedStyle(t.parentElement).backgroundColor : null,
        shadow: t ? getComputedStyle(t.parentElement).boxShadow : null,
      };
    })) || null;
  } catch (e) { report.errors.push('牌河几何检查: ' + e.message); }

  /* -- 出牌区容量：牌放大后仍要装得下一局的弃牌（每格塞满 18 张，数完整可见的张数） -- */
  try {
    const is3DCap = await page.evaluate(() => !!(window.__mjTable3d && window.__mjTable3d.is3D));
    report.interaction.riverCap = is3DCap ? null   // 3D：牌河按 6×3 网格自动扩行，DOM 容量断言不适用
      : (await page.evaluate(() => {
      const ui = window.__mahjong.ui, eng = ui.engine;
      const T = window.MJ.tileToIndex;
      const backup = eng.players.map(p => p.discards.slice());
      const pool = ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1p', '2p', '3p', '4p', '5p', '6p', '7p', '8p', '9p'];
      eng.players.forEach(p => { p.discards = pool.map(T); });
      ui._riverSeen = [0, 0, 0, 0];
      ui.renderRivers({ animate: false });
      const res = [0, 1, 2, 3].map(pid => {
        const box = document.getElementById('river-' + pid);
        const b = box.getBoundingClientRect();
        const tiles = [...box.querySelectorAll('.tile')];
        const visible = tiles.filter(t => {
          const r = t.getBoundingClientRect();
          return r.top >= b.top - 1 && r.bottom <= b.bottom + 1;
        }).length;
        return { total: tiles.length, visible };
      });
      eng.players.forEach((p, i) => { p.discards = backup[i]; });
      ui._riverSeen = [0, 0, 0, 0];
      ui.renderRivers({ animate: false });
      return res;
    })) || null;
  } catch (e) { report.errors.push('牌河容量检查: ' + e.message); }

  /* -- 副露摆放：吃/碰/杠必须渲染在对应玩家自己的座位内，并标注被鸣的那张 -- */
  try {
    report.interaction.meldLayout = await page.evaluate(() => {
      const ui = window.__mahjong.ui;
      const eng = ui.engine;
      const CJ = window.MJ.tileToIndex;
      const backup = eng.players.map(p => ({ melds: p.melds.map(m => ({ ...m })), hand: p.hand.slice() }));
      eng.players[1].melds = [{ type: 'pong', tile: CJ('5m'), tiles: [CJ('5m'), CJ('5m'), CJ('5m')], from: 0 }];
      eng.players[2].melds = [{ type: 'chi', tile: CJ('3p'), tiles: [CJ('2p'), CJ('3p'), CJ('4p')], from: 1 }];
      eng.players[3].melds = [{ type: 'kong', tile: CJ('7s'), tiles: [CJ('7s'), CJ('7s'), CJ('7s'), CJ('7s')], from: -1, concealed: true }];
      ui.renderAll();
      const d3 = window.__mjTable3d;
      if (d3 && d3.is3D) {
        const dbg = ui.t3d.debug();
        const res = {
          inSeat1: dbg.meldGroups(1),
          inSeat2: dbg.meldGroups(2),
          inSeat3: dbg.meldGroups(3),
          // 被鸣牌横置计数（暗杠 from=-1 不标注）
          claimed1: dbg.meldClaimed(1),
          claimed2: dbg.meldClaimed(2),
          claimed3: dbg.meldClaimed(3),
          meldInRiver: 0,   // 3D：副露与牌河分属不同 Group，结构上不可能混入
        };
        eng.players.forEach((p, i) => { p.melds = backup[i].melds; p.hand = backup[i].hand; });
        ui.renderAll();
        return res;
      }
      const scope = (pid) => document.querySelector(pid === 0 ? '#me' : '#seat-' + pid);
      const res = {
        inSeat1: scope(1).querySelectorAll('.meld').length,
        inSeat2: scope(2).querySelectorAll('.meld').length,
        inSeat3: scope(3).querySelectorAll('.meld').length,
        // 被鸣的那张有金框（暗杠 from=-1 不标注）
        claimed1: scope(1).querySelectorAll('.meld .tile.claimed').length,
        claimed2: scope(2).querySelectorAll('.meld .tile.claimed').length,
        claimed3: scope(3).querySelectorAll('.meld .tile.claimed').length,
        // 副露不得跑到牌河里
        meldInRiver: document.querySelectorAll('#rivers .meld').length,
      };
      eng.players.forEach((p, i) => { p.melds = backup[i].melds; p.hand = backup[i].hand; });
      ui.renderAll();
      return res;
    });
  } catch (e) { report.errors.push('副露布局检查: ' + e.message); }

  /* -- 弹窗：玩法规则 -- */
  try {
    await page.click('#btn-rules');
    await page.waitForSelector('.modal-mask', { timeout: 5000 });
    const rulesText = await page.$eval('.modal', (e) => e.innerText.slice(0, 400));
    const hasRules = /吃|碰|杠|和|倍率/.test(rulesText);
    await page.screenshot({ path: shot('modal-rules') });
    // 关闭：点击弹窗内最后一个按钮（通常是「知道了/开始游戏」）
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.modal .act-btn')];
      if (btns.length) btns[btns.length - 1].click();
    });
    await sleep(300);
    const closed = await page.evaluate(() => !document.querySelector('.modal-mask'));
    report.interaction.rulesModal = { opened: true, hasRulesText: hasRules, closed };
  } catch (e) { report.errors.push('规则弹窗: ' + e.message); }

  /* -- 弹窗：重新开局（取消分支，不真的重开） -- */
  try {
    await page.click('#btn-restart');
    await page.waitForSelector('.modal-mask', { timeout: 5000 });
    await page.screenshot({ path: shot('modal-restart') });
    const cancelled = await page.evaluate(() => {
      const btns = [...document.querySelectorAll('.modal .act-btn')];
      const cancel = btns.find(b => b.textContent.indexOf('取消') >= 0);
      if (cancel) { cancel.click(); return true; }
      return false;
    });
    await sleep(400);
    // 等弹窗真正关掉（cancel 点击后 closeModal 会清空 #modal-root），
    // 再断言「回到对局」。否则可能与「流局/和牌」等后续弹窗叠在一起而误判。
    await page.waitForFunction(() => !document.querySelector('.modal-mask'), { timeout: 5000, polling: 80 })
      .catch(() => { /* 超时则按下面断言如实失败 */ });
    const stillPlaying = await page.evaluate(() => {
      if (document.querySelector('.modal-mask')) return false;
      const d3 = window.__mjTable3d;
      return (d3 && d3.is3D) ? d3.handCount(0) >= 13 : document.querySelectorAll('#my-hand .tile').length >= 13;
    });
    report.interaction.restartModal = { opened: true, cancelButtonFound: cancelled, modalClosedAndGameAlive: stillPlaying };
  } catch (e) { report.errors.push('重开弹窗: ' + e.message); }

  await page.close();

  /* ============ C. file:// 直接打开（双击可用，无服务器） ============ */
  try {
    const fpage = await browser.newPage();
    const ferrs = [];
    fpage.on('pageerror', (e) => ferrs.push('pageerror: ' + e.message));
    fpage.on('console', (m) => { if (m.type() === 'error') ferrs.push('console.error: ' + m.text()); });
    await fpage.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    const fileUrl = 'file:///' + path.resolve(__dirname, '..', 'index.html').replace(/\\/g, '/');
    await fpage.goto(fileUrl, { waitUntil: 'load', timeout: 30000 });
    await enterTable(fpage);
    await fpage.waitForFunction(HAND_READY, { timeout: 20000, polling: 100 });
    await sleep(900);
    const fm = await fpage.evaluate(measure);
    await fpage.screenshot({ path: shot('file-protocol') });
    report.fileProtocol = { url: fileUrl, handTiles: fm.counts.myHand, round: fm.round, errors: ferrs };
    await fpage.close();
  } catch (e) {
    report.fileProtocol = { error: e.message };
    report.errors.push('file:// 打开失败: ' + e.message);
  }

  await browser.close();

  /* ============ 输出 ============ */
  console.log('\n================ E2E 结果 ================');
  console.log('视口渲染：');
  for (const v of report.viewports) {
    console.log(`  ${v.viewport.padEnd(17)} ${String(v.vw).padStart(4)}×${String(v.vh).padEnd(5)}` +
      ` 牌${v.tileBox ? v.tileBox.w + '×' + v.tileBox.h : '?'} 河牌${v.riverTileBox ? v.riverTileBox.w + '×' + v.riverTileBox.h : '?'}` +
      ` 手${String(v.counts.myHand).padStart(2)}(${v.handRows}行)` +
      ` 河${String(v.counts.riverTotal).padStart(2)} 对${String(v.counts.seat2).padStart(2)} 左${String(v.counts.seat3).padStart(2)} 右${String(v.counts.seat1).padStart(2)}` +
      ` 溢出X=${v.overflowX ? 'YES✗' : 'no'} Y=${v.overflowY ? 'YES✗' : 'no'}` +
      ` 碰撞[重叠${v.collide && v.collide.riversOverlap ? 'YES✗' : 'no'} 左${v.collide && v.collide.left ? 'YES✗' : 'no'} 右${v.collide && v.collide.right ? 'YES✗' : 'no'}]` +
      ` 适配[手牌底${v.fit ? v.fit.handBottom + (v.fit.handInView ? '✓' : '✗') : '?'} 侧栏${v.fit && v.fit.seatsInView ? '✓' : '✗'} 牌河在中央${v.fit && v.fit.riversInCenter ? '✓' : '✗'}]` +
      ` 四河[${v.counts.r0}/${v.counts.r1}/${v.counts.r2}/${v.counts.r3}] 数据一致=${v.riverMatch ? '✓' : '✗'}` +
      ` 裸区${v.riverBare ? '✓' : '✗'} 最新牌完整=${v.cursorFit === null ? '—' : (v.cursorFit ? '✓' : '✗')}` +
      (v.errors.length ? `  ⚠${v.errors.length}条控制台消息` : ''));
  }
  console.log('\n交互出牌：');
  for (const s of report.interaction.discardSteps) {
    console.log(`  第${s.round}手 ${s.roundName}  选中=${s.selected ? 'OK' : '✗'}  手牌 ${s.handBefore}→${s.handAfter}` +
      `  我方牌河 ${s.myRiverBefore}→${s.myRiverAfter}  全河 ${s.riverBefore}→${s.riverAfter}  悬浮光标=${s.cursorMine ? 'OK' : '✗'}  ${s.wallBefore}→${s.wallAfter}`);
  }
  if (report.interaction.claimPrompts && report.interaction.claimPrompts.length) {
    console.log(`  鸣牌询问「过」共处理 ${report.interaction.claimPrompts.length} 次：`, JSON.stringify([...new Set(report.interaction.claimPrompts)].slice(0, 6)));
  } else {
    console.log('  （本局未出现人类鸣牌询问）');
  }
  if (report.interaction.rulesModal) console.log('  规则弹窗:', JSON.stringify(report.interaction.rulesModal));
  if (report.interaction.restartModal) console.log('  重开弹窗:', JSON.stringify(report.interaction.restartModal));
  if (report.interaction.animSpec) {
    const a = report.interaction.animSpec;
    console.log(`  发牌动效: 重渲染后残留入场动画=${a.after} 运行中动画=${a.running}/${a.running2} 新牌标记=${a.lastDrawn}`);
  }
  if (report.interaction.sfx) {
    console.log(`  音效: 缺失=${JSON.stringify(report.interaction.sfx.missing)} 异常=${report.interaction.sfx.err} AudioContext=${report.interaction.sfx.hasCtx}/${report.interaction.sfx.state}`);
  }
  if (report.interaction.sfxOrganic) {
    const o = report.interaction.sfxOrganic;
    console.log(`  对局内触发: 吃=${o.chi} 碰=${o.pong} 胡=${o.win} 发牌=${o.deal} 浮字=${JSON.stringify(o.flash)}`);
  }
  if (report.interaction.sfxSync) {
    const s = report.interaction.sfxSync;
    console.log(`  音效↔浮字同步: animateClaim('chi') → 音效+${s.chiDelta}, 浮字显示=${s.shown}, 文案=${s.text}`);
  }
  if (report.interaction.rivers) {
    const r = report.interaction.rivers;
    console.log(`  四家牌河: DOM[我${r.per[0].dom}/右${r.per[1].dom}/对${r.per[2].dom}/左${r.per[3].dom}] 数据[我${r.per[0].data}/右${r.per[1].data}/对${r.per[2].data}/左${r.per[3].data}] 一致=${r.match ? '✓' : '✗'} 悬浮光标=${r.cursor}`);
  }
  if (report.interaction.riverGeom) {
    const g = report.interaction.riverGeom;
    const ratio = (g.riverTile && g.handTile) ? (g.riverTile.w / g.handTile.w).toFixed(2) : '?';
    console.log(`  已出过的牌: ${g.riverTile ? g.riverTile.w + '×' + g.riverTile.h : '?'} 手牌 ${g.handTile ? g.handTile.w + '×' + g.handTile.h : '?'}` +
      ` 相对手牌=${ratio} 四区越界=${g.outside} 四区重叠=${g.overl} 底板=${g.bg} box-shadow=${g.shadow}`);
  }
  if (report.interaction.riverCap) {
    console.log('  出牌区容量(塞满18张):', report.interaction.riverCap.map((c, i) => `#${i} ${c.visible}/${c.total}`).join('  '));
  }
  if (report.interaction.meldLayout) {
    const m = report.interaction.meldLayout;
    console.log(`  副露摆放: 各座位副露数[右${m.inSeat1}/对${m.inSeat2}/左${m.inSeat3}] 被鸣标注[右${m.claimed1}/对${m.claimed2}/左${m.claimed3}(暗杠0)] 误入牌河=${m.meldInRiver}`);
  }
  if (report.fileProtocol) console.log('\nfile:// 直接打开:', JSON.stringify(report.fileProtocol));
  console.log('\npageerror:', report.pageErrors.length, JSON.stringify(report.pageErrors.slice(0, 6)));
  console.log('console.error:', report.consoleErrors.length, JSON.stringify(report.consoleErrors.slice(0, 6)));
  console.log('console.warn:', report.consoleWarnings.length, JSON.stringify(report.consoleWarnings.slice(0, 4)));
  console.log('请求失败:', report.requestsFailed.length, JSON.stringify(report.requestsFailed.slice(0, 4)));
  console.log('测试脚本错误:', report.errors.length, JSON.stringify(report.errors.slice(0, 4)));
  console.log('==========================================\n');

  const vpOk = report.viewports.every(v => !v.overflowX && v.counts.myHand >= 13 && !v.errors.length
    && (!v.collide || (!v.collide.left && !v.collide.right && !v.collide.riversOverlap))
    && (!v.fit || (v.fit.handInView && v.fit.seatsInView && v.fit.handNotOverflow && v.fit.topAboveRiver && v.fit.riversInCenter))
    && v.riverMatch !== false && v.counts.cursor <= 1 && v.handRows >= 1 && v.handRows <= 2
    && (v.vw > 520 ? v.handRows === 1 : true)
    // 出牌区无半透明底板；最新弃牌不被裁切；已出牌尺寸 ≥ 手牌宽的 42%（"放大显示"的回归锁）
    && v.riverBare !== false && v.cursorFit !== false
    && (!v.riverTileBox || !v.tileBox || v.riverTileBox.w >= v.tileBox.w * 0.42));
  const playOk = report.interaction.discardSteps.length >= 5 &&
    report.interaction.discardSteps.every(s => s.selected && s.handAfter === s.handBefore - 1);
  const modalOk = report.interaction.rulesModal && report.interaction.rulesModal.opened && report.interaction.rulesModal.closed &&
    report.interaction.restartModal && report.interaction.restartModal.modalClosedAndGameAlive;
  const fileOk = report.fileProtocol && !report.fileProtocol.error && report.fileProtocol.handTiles >= 13 && report.fileProtocol.errors.length === 0;
  const animOk = report.interaction.animSpec === null || (report.interaction.animSpec && report.interaction.animSpec.after === 0
    && report.interaction.animSpec.running === 0 && report.interaction.animSpec.running2 === 0
    && report.interaction.animSpec.lastDrawn <= 1);
  const sfxOk = report.interaction.sfx && report.interaction.sfx.missing.length === 0 && !report.interaction.sfx.err
    && report.interaction.sfxSync && report.interaction.sfxSync.chiDelta === 1
    && report.interaction.sfxSync.shown && report.interaction.sfxSync.text === '吃';
  const rv = report.interaction.rivers;
  const riversOk = !!rv && rv.match && rv.cursor <= 1 && rv.distinct;
  const ml = report.interaction.meldLayout;
  const meldOk = !!ml && ml.inSeat1 === 1 && ml.inSeat2 === 1 && ml.inSeat3 === 1
    && ml.claimed1 === 1 && ml.claimed2 === 1 && ml.claimed3 === 0 && ml.meldInRiver === 0;
  const rg = report.interaction.riverGeom;
  const geomOk = rg === null || (!!rg && !!rg.riverTile && !!rg.handTile
    && rg.riverTile.w >= rg.handTile.w * 0.42          // 已出牌已放大
    && rg.rivers === 4 && rg.outside === 0 && rg.overl === 0
    && rg.bg === 'rgba(0, 0, 0, 0)' && rg.shadow === 'none');  // 出牌区无半透明底板
  // 一局最多打 18 张，四块出牌区都要能完整容纳（放不下就会把最早的弃牌裁掉）
  const capOk = report.interaction.riverCap === null ||
    (!!report.interaction.riverCap && report.interaction.riverCap.every(c => c.visible >= 16));
  const clean = !report.pageErrors.length && !report.consoleErrors.length && !report.requestsFailed.length;
  const pass = vpOk && playOk && modalOk && fileOk && animOk && sfxOk && riversOk && meldOk && geomOk && capOk && clean && !report.errors.length;
  console.log(pass ? 'E2E 全部通过 ✓'
    : `E2E 未通过 ✗  [视口:${vpOk} 交互:${playOk} 弹窗:${modalOk} file://:${fileOk} 动效:${animOk} 音效:${sfxOk} 牌河:${riversOk} 副露:${meldOk} 出牌区几何:${geomOk} 容量:${capOk} 无错误:${clean}]`);
  process.exit(pass ? 0 : 1);
})().catch((e) => {
  console.error('E2E 致命错误:', e && e.stack || e);
  process.exit(2);
});
