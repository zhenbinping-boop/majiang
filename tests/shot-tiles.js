/**
 * tests/shot-tiles.js — 牌面 3D 质感特写（人工评审用）
 * 输出：手牌特写、牌河特写、牌墙牌背特写、整桌
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
    args: ['--no-first-run', '--disable-gpu', '--mute-audio', '--font-render-hinting=none'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 3 });
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('#my-hand .tile').length >= 13, { timeout: 20000 });
  await sleep(1200);

  // 关掉可能存在的开局弹窗
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.modal button, .modal .act-btn')]
      .find(b => /关|知道|确定|继|开始/.test(b.textContent));
    if (btn) btn.click();
  });
  await sleep(400);

  // 打 3 手制造牌河 + 副露
  for (let i = 0; i < 3; i++) {
    try {
      await page.waitForFunction(() => {
        const b = document.getElementById('turn-banner');
        return b && b.textContent.indexOf('点击手牌') >= 0;
      }, { timeout: 40000, polling: 150 });
      await page.click('#my-hand .tile:last-child');
      await sleep(700);
    } catch (e) { /* ignore */ }
  }
  await sleep(900);

  // 整桌
  await page.screenshot({ path: path.join(OUT, 'tile-full.png') });

  // 手牌特写
  const hand = await page.$('#my-hand');
  if (hand) await hand.screenshot({ path: path.join(OUT, 'tile-hand.png') });

  // 我方牌河特写
  const r0 = await page.$('#river-0');
  if (r0) await r0.screenshot({ path: path.join(OUT, 'tile-river.png') });

  // 对家牌墙（牌背）特写
  const seat2 = await page.$('#seat-2');
  if (seat2) await seat2.screenshot({ path: path.join(OUT, 'tile-back.png') });

  // 中央区特写
  const center = await page.$('#center');
  if (center) await center.screenshot({ path: path.join(OUT, 'tile-center.png') });

  console.log('已生成 shots/tile-*.png');
  await browser.close();
})();
