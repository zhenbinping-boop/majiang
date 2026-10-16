/**
 * tests/table3d.js — Three.js 真 3D 牌桌专项验证
 *
 * 校验点（每视口）：
 *   1. WebGL 场景挂载成功：is3D = true、#table-3d 画布存在且铺满 #table
 *   2. 发牌后 mesh 数量正确：我方 14 张 + 三家暗牌 13×3 = 53
 *   3. 我方手牌 14 张（含第 14 张摸牌自动留间距，由 syncHand 内部保证）
 *   4. 点击选牌 → 再击出牌：手牌 14→13、我方牌河 0→1（等 pending 落桌后计数）
 *   5. 竖屏视口下画布布局尺寸 = 旋转后的逻辑视口（--vw/--vh）
 *   6. 全程零脚本错误
 *
 * 运行：NODE_PATH=<managed node workspace>/node_modules node tests/table3d.js
 */
'use strict';
const path = require('path');
const { pickChip } = require('./helpers');
const fs = require('fs');
const puppeteer = require('puppeteer-core');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.BASE_URL || 'http://127.0.0.1:8765';
const OUT = path.resolve(__dirname, '..', 'shots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const CASES = [
  { name: 't3d-desktop',  width: 1440, height: 900, isMobile: false },
  { name: 't3d-mobile',   width: 844,  height: 390, isMobile: true  },
  { name: 't3d-portrait', width: 390,  height: 844, isMobile: true  },
];

/** 等待出牌飞行落桌（pending 清空） */
async function waitPendingSettle(page, timeout = 3000) {
  await page.waitForFunction(() => {
    const d = window.__mjTable3d;
    return !d || !d.is3D || d.pendingCount() === 0;
  }, { timeout, polling: 60 }).catch(() => {});
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
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });

  const results = [];

  for (const c of CASES) {
    await page.setViewport({
      width: c.width, height: c.height, deviceScaleFactor: 1,
      isMobile: c.isMobile, hasTouch: c.isMobile,
    });
    await page.goto(BASE + '/index.html', { waitUntil: 'networkidle0' });
    await sleep(800);

    // 主界面 → 点「开始游戏」→ 翻牌放大转场 → 牌桌
    await page.evaluate(() => {
      const q = document.getElementById('btn-quick');
      if (q) q.click();
    });
    await page.waitForFunction(
      () => window.__mjTable3d && window.__mjTable3d.is3D && window.__mjTable3d.handCount(0) >= 13,
      { timeout: 25000, polling: 100 }
    );
    await pickChip(page);   // 拿牌后选筹码弹窗
    await sleep(1500);

    const r = await page.evaluate(() => {
      const d = window.__mjTable3d;
      const ui = window.__mahjong.ui;
      const cv = document.getElementById('table-3d');
      const tbl = ui.$ ? ui.$('table') : document.getElementById('table');
      const cs = getComputedStyle(document.getElementById('app'));
      const m = cs.transform;
      let deg = 0;
      if (m && m !== 'none') {
        const p = m.match(/matrix\(([^)]+)\)/);
        if (p) { const [a, b] = p[1].split(',').map(s => parseFloat(s.trim())); deg = Math.round(Math.atan2(b, a) * 180 / Math.PI); }
      }
      const ROTATED = Math.abs(deg) > 45;
      return {
        is3D: d.is3D,
        canvasPresent: d.canvasPresent(),
        meshes: d.tileMeshCount(),
        hand0: d.handCount(0),
        hand2: d.handCount(2),
        river0: d.riverCount(0),
        melds: d.meldCount(0),
        pending: d.pendingCount(),
        t3dMounted: !!(ui.t3d),
        // 画布铺满 #table：布局尺寸 = 容器布局尺寸（旋转坐标系下用 offsetWidth/Height）
        cvW: cv ? cv.offsetWidth : 0,
        cvH: cv ? cv.offsetHeight : 0,
        tblW: tbl ? tbl.offsetWidth : 0,
        tblH: tbl ? tbl.offsetHeight : 0,
        appDeg: deg, rotated: ROTATED,
        appW: Math.round(parseFloat(cs.width)),
        appH: Math.round(parseFloat(cs.height)),
      };
    });
    r.canvasCovers = r.cvW === r.tblW && r.cvH === r.tblH && r.cvW > 0;
    r.meshOk = r.meshes === 53;
    r.handOk = r.hand0 === 14 && r.hand2 === 13;

    // 点击选牌 → 截图 → 再击出牌
    await page.evaluate(() => window.__mjTable3d.clickHandTile(0));
    await sleep(450);
    await page.screenshot({ path: path.join(OUT, c.name + '-selected.png') });
    const before = await page.evaluate(() => window.__mjTable3d.handCount(0));
    await page.evaluate(() => window.__mjTable3d.clickHandTile(0));
    await waitPendingSettle(page);
    await sleep(400);
    const after = await page.evaluate(() => ({
      hand: window.__mjTable3d.handCount(0),
      river: window.__mjTable3d.riverCount(0),
    }));
    r.discardOk = before === 14 && after.hand === 13 && after.river === 1;
    r.discard = { before, after };
    await page.screenshot({ path: path.join(OUT, c.name + '-discard.png') });

    results.push({ c, r });
  }

  await browser.close();

  /* ---------- 输出 ---------- */
  console.log('\n============ 3D 牌桌专项验证 ============\n');
  let allOk = true;
  for (const { c, r } of results) {
    let rowOk = true;
    const mark = (v) => { if (!v) rowOk = false; return v ? '✓' : '✗'; };
    console.log('【' + c.name + '】 视口 ' + c.width + '×' + c.height + (c.isMobile ? ' (mobile)' : ''));
    console.log('  3D 挂载       : is3D=' + r.is3D + ' 画布=' + r.canvasPresent + ' t3d=' + r.t3dMounted + '  ' + mark(r.is3D && r.canvasPresent && r.t3dMounted));
    console.log('  画布铺满      : 画布 ' + r.cvW + '×' + r.cvH + ' / 容器 ' + r.tblW + '×' + r.tblH + '  ' + mark(r.canvasCovers));
    console.log('  mesh 数量     : ' + r.meshes + ' (期望 53)  ' + mark(r.meshOk));
    console.log('  手牌          : 我 ' + r.hand0 + ' / 对家 ' + r.hand2 + '  ' + mark(r.handOk));
    console.log('  点击出牌      : ' + JSON.stringify(r.discard) + '  ' + mark(r.discardOk));
    if (c.name === 't3d-portrait') {
      console.log('  竖屏旋转      : ' + r.appDeg + '°  app ' + r.appW + '×' + r.appH + '  ' + mark(r.rotated));
    }
    console.log('  → ' + (rowOk ? '通过 ✓' : '未通过 ✗'));
    console.log('');
    if (!rowOk) allOk = false;
  }

  console.log('脚本错误: ' + errors.length + (errors.length ? '\n  ' + errors.join('\n  ') : ''));
  console.log('\n' + (allOk && errors.length === 0 ? '全部通过 ✓' : '存在失败项 ✗'));
  console.log('截图已存至 shots/t3d-*.png');

  process.exit(allOk && errors.length === 0 ? 0 : 1);
})().catch((e) => { console.error('致命错误:', e && e.stack || e); process.exit(2); });
