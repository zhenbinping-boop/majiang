/**
 * probe-pick.js — 真实指针事件拾取探针
 * 与 table3d.js 调试接口（clickHandTile）不同，这里用 page.mouse 在
 * 手牌 mesh 投影到屏幕的真实坐标上 hover + click，完整走
 * pointermove/pointerdown → _canvasLocal → Raycaster → onPickTile 链路。
 */
const puppeteer = require('puppeteer-core');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8765/index.html';
const SHOTS = path.join(__dirname, '..', 'shots');

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
      '--autoplay-policy=no-user-gesture-required', '--mute-audio',
    ],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [console.error]', m.text()); });

  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.waitForFunction(
    () => window.__mjHome && document.getElementById('btn-quick'),
    { timeout: 20000, polling: 60 }
  );
  await page.evaluate(() => document.getElementById('btn-quick').click());
  await page.waitForFunction(
    () => {
      const home = document.getElementById('home');
      const app = document.getElementById('app');
      return (!home || home.classList.contains('hidden')) && app && !app.classList.contains('hidden');
    },
    { timeout: 20000, polling: 80 }
  );
  await page.waitForFunction(() => {
    const d = window.__mjTable3d;
    return d && d.is3D && d.handCount(0) >= 13;
  }, { timeout: 30000, polling: 100 });
  await page.waitForFunction(() => !!window.__mahjong.ui.handClickResolve, { timeout: 30000, polling: 100 });
  await new Promise((r) => setTimeout(r, 900)); // 等入场补间收敛

  // 计算第 5 张手牌的屏幕坐标（世界坐标 → 相机投影 → 屏幕像素）
  const tileScreen = await page.evaluate(() => {
    const t = window.__mahjong.ui.t3d;
    const grp = t.groups[0].hand;
    const mesh = grp.children[5];
    const v = mesh.position.clone();
    if (grp.parent) v.applyMatrix4(grp.matrixWorld);
    v.project(t.camera);
    const cv = t.renderer.domElement;
    const r = cv.getBoundingClientRect();
    return {
      x: r.left + (v.x * 0.5 + 0.5) * r.width,
      y: r.top + (-v.y * 0.5 + 0.5) * r.height,
      canvasRect: { l: r.left, t: r.top, w: r.width, h: r.height },
      appTransform: getComputedStyle(document.getElementById('app')).transform,
    };
  });
  console.log('牌#5 屏幕坐标:', JSON.stringify(tileScreen));

  // 该点上最顶层的元素是谁？（检测 HUD 遮挡）
  const topEl = await page.evaluate((p) => {
    const el = document.elementFromPoint(p.x, p.y);
    if (!el) return 'null';
    return el.id || el.className || el.tagName;
  }, tileScreen);
  console.log('点击点顶层元素:', topEl);

  // 1) hover
  await page.mouse.move(tileScreen.x, tileScreen.y);
  await new Promise((r) => setTimeout(r, 260));
  const hoverIdx = await page.evaluate(() => {
    const t = window.__mahjong.ui.t3d;
    return { hoverIdx: t.hoverIdx, ndcPick: -9 };
  });
  console.log('hover 后 hoverIdx =', JSON.stringify(hoverIdx));

  // 2) 第一次点击 → 选中
  await page.mouse.click(tileScreen.x, tileScreen.y);
  await new Promise((r) => setTimeout(r, 320));
  const sel = await page.evaluate(() => ({
    selectedTile: window.__mahjong.ui.selectedTile,
    selectedIdx: window.__mahjong.ui.t3d.selectedIdx,
    handN: window.__mjTable3d.handCount(0),
  }));
  console.log('第一次点击后:', JSON.stringify(sel));

  // 3) 第二次点击 → 出牌
  await page.mouse.click(tileScreen.x, tileScreen.y);
  await new Promise((r) => setTimeout(r, 1400)); // 等出牌动画 + pending 揭示
  const after = await page.evaluate(() => {
    const t = window.__mahjong.ui.t3d;
    return {
      handN: window.__mjTable3d.handCount(0),
      riverN: t.debug().riverCount(0),
      pending: t.debug().pendingCount ? t.debug().pendingCount() : 'n/a',
    };
  });
  console.log('第二次点击后:', JSON.stringify(after));
  console.log(after.handN === 13 ? 'PICK-OK（真实指针出牌成功）' : 'PICK-FAIL（真实指针出牌失败）');

  await page.screenshot({ path: path.join(SHOTS, 'probe-pick.png') });
  await browser.close();
})().catch((e) => { console.error('PROBE-ERROR:', e.message); process.exit(1); });
