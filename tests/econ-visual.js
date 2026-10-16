/* 经济系统视觉验收：拿牌后筹码弹窗 / 代币徽标 / 皮肤面板 / 解锁扣款 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const fs = require('fs');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8765';
const OUT = path.resolve(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });
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
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  await page.setViewport({ width: 1440, height: 900 });

  /* A. 主界面：无局级选择，代币徽标直接显示 50 万 */
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction(() => window.MJEconomy, { timeout: 15000, polling: 60 });
  await sleep(1200);
  const homeState = await page.evaluate(() => ({
    coins: window.MJEconomy.getCoins(),
    coinVal: document.querySelector('[data-coin-val]')?.textContent,
    hasStakePick: !!document.getElementById('stake-pick'),
  }));
  await page.screenshot({ path: path.join(OUT, 'econ-home.png') });

  /* B. 进对局：发牌后弹出筹码选择 → 选 1500 → 弹窗关闭 */
  await page.evaluate(() => document.getElementById('btn-quick').click());
  await page.waitForFunction(() => {
    const home = document.getElementById('home');
    const app = document.getElementById('app');
    return (!home || home.classList.contains('hidden')) && app && !app.classList.contains('hidden');
  }, { timeout: 20000, polling: 80 });
  await page.waitForFunction(() => window.__mahjong && window.__mahjong.ui && window.__mahjong.ui.t3d, { timeout: 10000 });
  await page.waitForFunction(() => {
    const modal = document.getElementById('modal-root');
    return modal && modal.children.length > 0 &&
      [...modal.querySelectorAll('.chip-btn')].length >= 3;
  }, { timeout: 20000, polling: 100 });
  await sleep(600);
  await page.screenshot({ path: path.join(OUT, 'econ-chipmodal.png') });
  const chipState = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.chip-btn .chip-v')].map(b => b.textContent.trim());
    return { chipBtns: btns, chipBefore: window.MJEconomy.getChip() };
  });
  await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.chip-btn')];
    btns.find(b => b.textContent.includes('1,500')).click();
  });
  await sleep(700);
  const afterChip = await page.evaluate(() => ({
    chip: window.MJEconomy.getChip(),
    modalGone: document.getElementById('modal-root').children.length === 0,
    handReady: window.__mahjong.ui.t3d.debug().handCount(0) === 14,
  }));
  await page.screenshot({ path: path.join(OUT, 'econ-table.png') });

  /* C. 皮肤面板：解锁鎏金 → 扣款 → 换上生效 */
  await page.evaluate(() => document.getElementById('btn-theme').click());
  await sleep(700);
  const panel = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.skin-row')].map(r => r.textContent.trim().slice(0, 22));
    return { rows };
  });
  await page.screenshot({ path: path.join(OUT, 'econ-skinpanel.png') });
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.skin-row')];
    const target = rows.find(r => r.textContent.includes('深海鎏金'));
    target.querySelector('.act-btn').click();
  });
  await sleep(900);
  const afterUnlock = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('.skin-row .act-btn')].map(b => b.textContent.trim());
    const coins = window.MJEconomy.getCoins();
    const theme = window.MJTable3D.currentTheme();
    document.querySelector('.modal-btns .act-btn').click(); // 关闭
    return { btns, coins, theme };
  });
  await sleep(700);
  await page.screenshot({ path: path.join(OUT, 'econ-ocean-applied.png') });

  console.log(JSON.stringify({ homeState, chipState, afterChip, panel, afterUnlock, errors: errors.length ? errors : 'none' }, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
