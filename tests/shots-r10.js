/* 截图核对：主界面（无局级）+ 筹码弹窗 + 牌河新间距 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:8765/index.html';
const OUT = path.resolve(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const { pickChip } = require('./helpers');

async function waitHumanDiscard(page, timeout = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const st = await page.evaluate(() => {
      const bar = document.getElementById('action-bar');
      return { barVisible: !!bar && !bar.classList.contains('hidden') };
    });
    if (st.barVisible) {
      await page.evaluate(() => {
        const bar = document.getElementById('action-bar');
        const btn = [...bar.querySelectorAll('.act-btn')].find((b) => b.textContent.indexOf('过') >= 0);
        if (btn) btn.click();
      });
      await sleep(300);
      continue;
    }
    if (await page.evaluate(() => !!window.__mahjong.ui.handClickResolve)) return true;
    await sleep(200);
  }
  return false;
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--enable-unsafe-swiftshader',
      '--autoplay-policy=no-user-gesture-required', '--mute-audio',
      '--use-gl=angle', '--use-angle=swiftshader'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  await page.goto(BASE, { waitUntil: 'networkidle0', timeout: 30000 });
  await sleep(1200);
  await page.screenshot({ path: path.join(OUT, 'r10-home.png') });

  await page.evaluate(() => document.getElementById('btn-quick').click());
  await page.waitForFunction(() => window.__mahjong && window.__mahjong.ui &&
    !document.getElementById('app').hidden, { timeout: 20000 });
  await page.waitForFunction(() => {
    const m = document.getElementById('modal-root');
    return m && m.querySelectorAll('.chip-btn').length >= 3;
  }, { timeout: 15000, polling: 100 });
  await sleep(400);
  await page.screenshot({ path: path.join(OUT, 'r10-chip.png') });

  await pickChip(page);
  /* 推进 8 回合让牌河铺开 */
  for (let i = 0; i < 8; i++) {
    if (!await waitHumanDiscard(page)) break;
    await page.evaluate(() => {
      const d3 = window.__mjTable3d;
      if (d3 && d3.is3D) d3.clickHandTile(d3.handCount(0) - 1);
    });
    await sleep(250);
    await page.evaluate(() => {
      const d3 = window.__mjTable3d;
      if (d3 && d3.is3D) d3.clickHandTile(d3.handCount(0) - 1);
    });
    await sleep(900);
  }
  await sleep(800);
  await page.screenshot({ path: path.join(OUT, 'r10-table.png') });
  console.log('shots done: r10-home / r10-chip / r10-table');
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
