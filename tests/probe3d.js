/**
 * tests/probe3d.js — 3D 牌桌冒烟探针（临时）
 * 验证 WebGL 可用性、table3d 挂载、牌 mesh 数量、点击出牌链路与截图。
 */
'use strict';
const path = require('path');
const puppeteer = require('puppeteer-core');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8765';
const OUT = path.resolve(__dirname, '..', 'shots');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
      '--autoplay-policy=no-user-gesture-required', '--mute-audio',
      '--use-gl=angle', '--use-angle=swiftshader'],
  });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });

  const webgl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
    if (!gl) return 'NONE';
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'webgl';
  });
  console.log('WebGL renderer:', webgl);

  await page.evaluate(() => document.getElementById('btn-quick').click());
  await page.waitForFunction(() => window.__mjTable3d && window.__mjTable3d.handCount(0) >= 13, { timeout: 25000, polling: 100 });
  await sleep(1500);

  const st = await page.evaluate(() => {
    const d = window.__mjTable3d;
    return {
      is3D: d.is3D, canvas: d.canvasPresent(), meshes: d.tileMeshCount(),
      hand0: d.handCount(0), hand2: d.handCount(2),
      river0: d.riverCount(0), melds: d.meldCount(0),
      t3dMounted: !!(window.__mahjong && window.__mahjong.ui.t3d),
    };
  });
  console.log('state:', JSON.stringify(st, null, 1));

  // 点击第 0 张手牌 → 选中 → 再点 → 出牌
  await page.evaluate(() => window.__mjTable3d.clickHandTile(0));
  await sleep(400);
  await page.screenshot({ path: path.join(OUT, 'probe3d-selected.png') });
  const before = await page.evaluate(() => window.__mjTable3d.handCount(0));
  await page.evaluate(() => window.__mjTable3d.clickHandTile(0));
  await sleep(1400);
  const after = await page.evaluate(() => window.__mjTable3d.handCount(0));
  console.log('discard: hand', before, '->', after);
  await page.screenshot({ path: path.join(OUT, 'probe3d-discard.png') });

  console.log('errors:', JSON.stringify(errs.slice(0, 6)));
  await browser.close();
  process.exit(errs.length ? 1 : 0);
})().catch((e) => { console.error('fatal:', e.message); process.exit(2); });
