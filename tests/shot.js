/**
 * tests/shot.js — 出图脚本（人工视觉评审用）
 * 生成：开局 / 中期对局 / 结算弹窗（金币赔率）/ 规则弹窗 / 手机竖屏
 * 用法: node tests/shot.js
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
const shot = (p) => path.join(OUT, p + '.png');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio', '--hide-scrollbars', '--font-render-hinting=none'],
  });

  /* ---- 桌面：开局 ---- */
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('#my-hand .tile').length >= 13, { timeout: 20000 });
  await sleep(1300);
  await page.screenshot({ path: shot('s-open') });

  /* ---- 桌面：中期（真实点击出牌 5 手） ---- */
  for (let i = 0; i < 5; i++) {
    try {
      await page.waitForFunction(() => {
        const b = document.getElementById('turn-banner');
        return b && b.textContent.indexOf('点击手牌') >= 0;
      }, { timeout: 60000, polling: 120 });
      const n = await page.$$eval('#my-hand .tile', els => els.length);
      await page.click('#my-hand .tile:last-child');
      await page.click('#my-hand .tile:last-child');
      await page.waitForFunction((k) => document.querySelectorAll('#my-hand .tile').length !== k, { timeout: 15000, polling: 80 }, n);
      await sleep(500);
    } catch (e) { break; }
  }
  await sleep(600);
  await page.screenshot({ path: shot('s-mid') });

  /* ---- 桌面：结算弹窗（构造一手「清一色 + 一气通贯 + 门清 + 自摸」） ---- */
  const ok = await page.evaluate(() => {
    try {
      const ctrl = window.__mahjong;
      const eng = ctrl.engine, ui = ctrl.ui, E = window.MJEngine, MJ = window.MJ;
      const T = (s) => { const n = parseInt(s, 10); const f = { m: 0, p: 9, s: 18, z: 26 }[s.slice(-1)]; return f + n - 1; };
      const w = eng.players[2];
      // 清一色 + 一气通贯 + 门清 + 自摸
      w.hand = ['1m', '2m', '3m', '4m', '5m', '6m', '7m', '8m', '9m', '1m', '2m', '3m', '1m'].map(T);
      w.melds = [];
      w.lastDraw = T('1m');
      const r = eng.settleWin(w, { selfDraw: true });
      const data = { winner: 2, selfDraw: true, fromDiscard: -1, result: r.result, payments: r.payments, winTile: r.winTile };
      ui.renderAll();
      ui.showSettlement(data);
      return { fans: r.result.fans.map(f => f.name + '×' + f.mult), total: r.result.totalMult, per: r.result.perPayer, gain: r.result.gain };
    } catch (e) { return { error: String(e && e.stack || e) }; }
  });
  console.log('结算样例:', JSON.stringify(ok));
  await sleep(1400);
  await page.screenshot({ path: shot('s-settle') });

  /* ---- 桌面：规则 + 赔率表 ---- */
  await page.evaluate(() => { document.getElementById('modal-root').innerHTML = ''; window.__mahjong.ui.showRules(); });
  await sleep(500);
  await page.screenshot({ path: shot('s-rules') });
  await page.evaluate(() => { window.__mahjong.ui.closeModal(); });

  /* ---- 吃碰浮字（构造一次「碰」的动效） ---- */
  await page.evaluate(() => { document.getElementById('modal-root').innerHTML = ''; window.__mahjong.ui.flash('碰', 'pong'); });
  await sleep(300);
  await page.screenshot({ path: shot('s-flash') });

  /* ---- 副露摆在各家身旁：为四家各造一组吃/碰/杠，检查空间归属与被鸣标注 ---- */
  await page.evaluate(() => {
    const ui = window.__mahjong.ui, eng = ui.engine;
    const T = window.MJ.tileToIndex;
    const mk = (n, t) => { const a = []; for (let i = 0; i < n; i++) a.push(T(t)); return a; };
    eng.players[0].melds = [{ type: 'pong', tile: T('5m'), tiles: mk(3, '5m'), from: 1 }];
    eng.players[1].melds = [{ type: 'chi', tile: T('3p'), tiles: [T('2p'), T('3p'), T('4p')], from: 0 },
    { type: 'pong', tile: T('9s'), tiles: mk(3, '9s'), from: 2 }];
    eng.players[2].melds = [{ type: 'kong', tile: T('7z'), tiles: mk(4, '7z'), from: -1, concealed: true }];
    eng.players[3].melds = [{ type: 'chi', tile: T('1m'), tiles: [T('1m'), T('2m'), T('3m')], from: 0 }];
    ui.renderAll();
  });
  await sleep(420);
  await page.screenshot({ path: shot('s-melds') });

  /* ---- 四家独立牌河 + 当前牌悬浮光标：为四家各铺一段牌河 ---- */
  await page.evaluate(() => {
    const ui = window.__mahjong.ui, eng = ui.engine;
    const T = window.MJ.tileToIndex;
    const seq = (arr) => arr.map(T);
    eng.players[0].discards = seq(['1m', '4p', '7s', '2z', '5m', '3s', '8p', '6m', '9s', '1z', '3p', '5s']);
    eng.players[1].discards = seq(['9p', '2s', '6z', '4m', '7p', '1s', '3m', '5z', '8s']);
    eng.players[2].discards = seq(['2m', '5p', '8s', '3z', '6s', '9m', '1p', '4s', '7m', '2p', '5z']);
    eng.players[3].discards = seq(['4z', '7s', '1m', '8p', '2s', '6m', '3s', '9p']);
    eng.lastDiscarder = 0;              // 全桌最新一张属于我 → 我方牌河末张出现悬浮光标
    ui._riverSeen = [0, 0, 0, 0];
    ui.renderRivers({ animate: false });
  });
  await sleep(360);
  await page.screenshot({ path: shot('s-rivers') });

  /* ---- 发牌动效：抓取逐张进场的中间帧 ---- */
  await sleep(1200);
  await page.evaluate(() => { window.__mahjong.ui.animateDeal(); });
  await sleep(230);
  await page.screenshot({ path: shot('s-deal') });

  /* ---- 摸牌动效：抓取新牌位移入场 + 金环高亮 ---- */
  await sleep(900);
  await page.evaluate(() => {
    const ui = window.__mahjong.ui, eng = window.__mahjong.engine;
    const tile = eng.players[0].hand[5];
    ui.freshTile = tile;
    ui.renderMySeat();
    ui.renderMyHand({ freshAnimate: true });
  });
  await sleep(80);
  await page.screenshot({ path: shot('s-draw') });
  await sleep(500);
  await page.screenshot({ path: shot('s-draw-done') });
  await page.close();

  /* ---- 手机竖屏 ---- */
  const m = await browser.newPage();
  await m.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await m.goto(BASE + '/index.html', { waitUntil: 'load' });
  await m.waitForFunction(() => document.querySelectorAll('#my-hand .tile').length >= 13, { timeout: 20000 });
  await sleep(1300);
  await m.screenshot({ path: shot('s-mobile') });
  await m.close();

  /* ---- 横屏手机 ---- */
  const l = await browser.newPage();
  await l.setViewport({ width: 844, height: 390, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await l.goto(BASE + '/index.html', { waitUntil: 'load' });
  await l.waitForFunction(() => document.querySelectorAll('#my-hand .tile').length >= 13, { timeout: 20000 });
  await sleep(1300);
  await l.screenshot({ path: shot('s-landscape') });
  await l.close();

  await browser.close();
  console.log('截图完成 →', OUT);
})().catch(e => { console.error(e); process.exit(1); });
