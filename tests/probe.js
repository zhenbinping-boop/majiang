/**
 * tests/probe.js — 单视口布局探针（诊断用）
 * 用法: node tests/probe.js 844 390
 */
'use strict';
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8765';

(async () => {
  const W = parseInt(process.argv[2] || '844', 10);
  const H = parseInt(process.argv[3] || '390', 10);
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-first-run', '--no-default-browser-check', '--disable-gpu', '--mute-audio', '--hide-scrollbars'] });
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('#my-hand .tile').length >= 13, { timeout: 20000 });
  await new Promise(r => setTimeout(r, 1200));
  const out = await page.evaluate(() => {
    const R = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { y: Math.round(b.top), h: Math.round(b.height), x: Math.round(b.left), w: Math.round(b.width) }; };
    const cs = getComputedStyle(document.documentElement);
    const t = document.querySelector('#my-hand .tile').getBoundingClientRect();
    const rv = document.querySelector('#river-0 .tile');
    const rvb = rv ? rv.getBoundingClientRect() : null;
    return {
      vw: window.innerWidth, vh: window.innerHeight,
      tileW: cs.getPropertyValue('--tile-w').trim(), tileH: cs.getPropertyValue('--tile-h').trim(),
      tilePx: [Math.round(t.width), Math.round(t.height)],
      riverTilePx: rvb ? [Math.round(rvb.width), Math.round(rvb.height)] : null,
      topbar: R('#topbar'), table: R('#table'), seat2: R('#seat-2'), seat3: R('#seat-3'), seat1: R('#seat-1'),
      me: R('#me'), mePanel: R('#me-panel'), hand: R('#my-hand'),
      panel2: R('#panel-2'), panel3: R('#panel-3'), panel1: R('#panel-1'),
      center: R('#center'), rivers: R('#rivers'),
      river2: R('#river-2'), river3: R('#river-3'), river1: R('#river-1'), river0: R('#river-0'),
      plaque: R('#center-plaque'), banner: R('#turn-banner'),
      /* 四家牌河是否各自落在中央区网格内、互不重叠 */
      riverBoxes: (() => {
        const ids = ['river-2', 'river-3', 'river-1', 'river-0'];
        const rects = ids.map(id => ({ id, r: R('#' + id) })).filter(o => o.r);
        const pairs = [];
        for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
          const a = rects[i].r, b = rects[j].r;
          const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
          const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
          if (ix > 1 && iy > 1) pairs.push(rects[i].id + '×' + rects[j].id + '=' + ix + 'x' + iy);
        }
        return pairs;
      })(),
      overlapPlaqueBanner: (() => {
        const a = R('#center-plaque'), b = R('#turn-banner');
        if (!a || !b) return null;
        const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        return { x: ix, y: iy };
      })(),
    };
  });
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
