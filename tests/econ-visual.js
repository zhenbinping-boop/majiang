/* 经济系统视觉验收：主界面局级选择 / 代币徽标 / 皮肤面板 / 结算代币行 */
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

  /* A. 主界面：局级选择 + 代币徽标 + 切换金局 */
  await page.goto(BASE + '/index.html', { waitUntil: 'load' });
  await page.waitForFunction(
    () => window.MJEconomy && document.querySelector('.stake-btn'), { timeout: 15000, polling: 60 });
  await page.evaluate(() => {
    document.querySelector('.stake-btn[data-stake="gold"]').click();
  });
  await sleep(1400);
  const homeState = await page.evaluate(() => ({
    stake: window.MJEconomy.getStake(),
    coins: window.MJEconomy.getCoins(),
    activeBtn: document.querySelector('.stake-btn.active')?.getAttribute('data-stake'),
    coinVal: document.querySelector('[data-coin-val]')?.textContent,
  }));
  await page.screenshot({ path: path.join(OUT, 'econ-home.png') });

  /* B. 进对局：顶栏局级徽标 + 代币；打开皮肤面板并解锁鎏金（先加币） */
  await page.evaluate(() => document.getElementById('btn-quick').click());
  await page.waitForFunction(() => {
    const home = document.getElementById('home');
    const app = document.getElementById('app');
    return (!home || home.classList.contains('hidden')) && app && !app.classList.contains('hidden');
  }, { timeout: 20000, polling: 80 });
  await page.waitForFunction(() => window.__mahjong && window.__mahjong.ui && window.__mahjong.ui.t3d, { timeout: 10000 });
  await page.waitForFunction(() => window.__mahjong.ui.t3d.debug().handCount(0) === 14, { timeout: 20000, polling: 100 });
  await sleep(2000);
  const tableState = await page.evaluate(() => ({
    stakeChip: document.getElementById('stake-chip')?.textContent,
    coinChip: document.getElementById('coin-chip')?.textContent,
  }));
  await page.evaluate(() => window.MJEconomy.addCoins(20000)); // 解锁与购买视觉验收用
  await page.evaluate(() => document.getElementById('btn-theme').click());
  await sleep(700);
  const panel = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.skin-row')].map(r => r.textContent.trim().slice(0, 22));
    const btns = [...document.querySelectorAll('.skin-row .act-btn')].map(b => b.textContent.trim());
    return { rows, btns };
  });
  await page.screenshot({ path: path.join(OUT, 'econ-skinpanel.png') });

  /* C. 解锁深海鎏金 → 面板刷新为「换上」→ 点换上 → 绒毡变蓝 */
  await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.skin-row')];
    const target = rows.find(r => r.textContent.includes('深海鎏金'));
    target.querySelector('.act-btn').click();
  });
  await sleep(900);
  const afterUnlock = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.skin-row .act-btn')].map(b => b.textContent.trim());
    const coins = window.MJEconomy.getCoins();
    const theme = window.MJTable3D.currentTheme();
    document.querySelector('.modal-btns .act-btn').click(); // 关闭
    return { rows, coins, theme };
  });
  await sleep(700);
  await page.screenshot({ path: path.join(OUT, 'econ-ocean-applied.png') });

  console.log(JSON.stringify({ homeState, tableState, panel, afterUnlock, errors: errors.length ? errors : 'none' }, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
