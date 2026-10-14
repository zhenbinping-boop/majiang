/**
 * tests/shot-land.js — 横屏对局实拍（作为竖屏旋转的目标参照）
 */
'use strict';
const path = require('path');
const puppeteer = require('puppeteer-core');
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8765';
const OUT = path.resolve(__dirname, '..', 'shots');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 844, height: 390, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await page.goto(BASE + '/index.html', { waitUntil: 'networkidle0' });
  await sleep(900);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.modal button, .modal .act-btn')]
      .find(b => /关|知道|确定|继|开始/.test(b.textContent));
    if (btn) btn.click();
  });
  await sleep(300);
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => { const t = document.querySelector('#my-hand .tile'); if (t) t.click(); });
    await sleep(200);
  }
  await sleep(600);
  await page.evaluate(() => {
    const bar = document.getElementById('action-bar');
    bar.classList.remove('hidden');
    bar.innerHTML = ['吃', '碰', '杠', '胡', '过'].map(t => '<button class="act-btn">' + t + '</button>').join('');
  });
  await sleep(300);
  const geo = await page.evaluate(() => {
    const g = (sel) => { const e = document.querySelector(sel); if (!e) return null;
      const b = e.getBoundingClientRect();
      return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }; };
    return { vw: innerWidth, vh: innerHeight, topbar: g('#topbar'), hand: g('#my-hand'),
      actionBar: g('#action-bar'), center: g('#center'), rivers: g('#rivers') };
  });
  console.log(JSON.stringify(geo, null, 2));
  await page.screenshot({ path: path.join(OUT, 'land-844x390.png') });
  console.log('已存 shots/land-844x390.png');
  await browser.close();
})();
