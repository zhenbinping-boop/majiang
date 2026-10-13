/**
 * tests/zoom.js — 局部放大截图（视觉评审用）
 * 对四家牌河、悬浮光标、副露做高倍率局部截图。
 * 用法: NODE_PATH=... node tests/zoom.js
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

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio', '--hide-scrollbars', '--font-render-hinting=none'],
  });
  // deviceScaleFactor 3 → 截图本身即为 3 倍像素，无需再做缩放
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 3 });
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('#my-hand .tile').length >= 13, { timeout: 20000 });
  await sleep(900);

  // 铺满四家牌河 + 副露
  await page.evaluate(() => {
    const ui = window.__mahjong.ui, eng = ui.engine;
    const T = window.MJ.tileToIndex;
    const mk = (n, t) => { const a = []; for (let i = 0; i < n; i++) a.push(T(t)); return a; };
    const seq = (a) => a.map(T);
    eng.players[0].discards = seq(['1m', '4p', '7s', '2z', '5m', '3s', '8p', '6m', '9s', '1z', '3p', '5s']);
    eng.players[1].discards = seq(['9p', '2s', '6z', '4m', '7p', '1s', '3m', '5z', '8s']);
    eng.players[2].discards = seq(['2m', '5p', '8s', '3z', '6s', '9m', '1p', '4s', '7m', '2p', '5z']);
    eng.players[3].discards = seq(['4z', '7s', '1m', '8p', '2s', '6m', '3s', '9p']);
    eng.players[0].melds = [{ type: 'pong', tile: T('5m'), tiles: mk(3, '5m'), from: 1 }];
    eng.players[1].melds = [{ type: 'chi', tile: T('3p'), tiles: [T('2p'), T('3p'), T('4p')], from: 0 }];
    eng.players[2].melds = [{ type: 'kong', tile: T('7z'), tiles: mk(4, '7z'), from: -1, concealed: true }];
    eng.players[3].melds = [{ type: 'chi', tile: T('1m'), tiles: [T('1m'), T('2m'), T('3m')], from: 0 }];
    eng.lastDiscarder = 0;
    ui._riverSeen = [0, 0, 0, 0];
    ui.renderAll();
    ui.renderRivers({ animate: false });
  });
  await sleep(600);

  const rects = await page.evaluate(() => {
    const R = (s) => { const e = document.querySelector(s); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height }; };
    return {
      myRiver: R('#river-0'), center: R('#rivers'), plaque: R('#center-plaque'),
      seat1: R('#seat-1'), seat2: R('#seat-2'), seat3: R('#seat-3'),
      myHand: R('#my-hand'), mePanel: R('#me-panel'),
    };
  });

  const pad = (r, p) => ({ x: Math.max(0, r.x - p), y: Math.max(0, r.y - p), width: r.width + p * 2, height: r.height + p * 2 });
  const grab = async (name, r) => { await page.screenshot({ path: path.join(OUT, '_zoom-' + name + '.png'), clip: r }); };

  await grab('rivers-all', pad(rects.center, 6));
  await grab('myriver-cursor', pad(rects.myRiver, 16));
  await grab('seat-right-melds', pad(rects.seat1, 6));
  await grab('seat-top-melds', pad(rects.seat2, 6));
  await grab('seat-left-melds', pad(rects.seat3, 6));
  await grab('myhand', pad(rects.myHand, 6));

  /* ---- 筒子全谱特写：核对一筒到九筒的点阵排布（尤其七筒的斜排） ---- */
  await page.evaluate(() => {
    const wrap = document.createElement('div');
    wrap.id = '__pins';
    wrap.style.cssText = 'position:fixed;left:14px;top:14px;z-index:99999;display:flex;gap:8px;'
      + 'padding:12px;background:#0a0f22;border:1px solid #2a3768;border-radius:10px;';
    [9, 10, 11, 12, 13, 14, 15, 16, 17].forEach(i => {      // 一筒 … 九筒
      const c = document.createElement('div');
      c.style.cssText = 'width:96px;height:131px;flex:0 0 auto;';
      c.innerHTML = window.MJ.tileFaceSVG(i);
      c.firstChild.style.width = '100%';
      c.firstChild.style.height = '100%';
      wrap.appendChild(c);
    });
    document.body.appendChild(wrap);
  });
  await sleep(250);
  const pins = await page.evaluate(() => {
    const b = document.getElementById('__pins').getBoundingClientRect();
    return { x: b.left, y: b.top, width: b.width, height: b.height };
  });
  await grab('pins', pins);
  await page.evaluate(() => { const e = document.getElementById('__pins'); if (e) e.remove(); });

  await browser.close();
  console.log('局部放大截图完成 →', OUT);
})().catch(e => { console.error(e); process.exit(1); });
