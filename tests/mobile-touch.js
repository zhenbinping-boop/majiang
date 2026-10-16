/* 移动端真实触摸链路测试：
   手机 viewport + hasTouch + page.touchscreen.tap —— 复现「移动端无法操作麻将」。
   覆盖 3D 路径（canvas 射线拾取，竖屏旋转坐标换算）与 DOM 路径（?ui=dom）。 */
const puppeteer = require('puppeteer-core');
const path = require('path');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:8765/index.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function enterTable(page, url) {
  await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 });
  await sleep(600);
  // 主界面点「开始游戏」（真实 tap）
  const btn = await page.$('#btn-quick');
  if (!btn) throw new Error('找不到 #btn-quick');
  const bb = await btn.boundingBox();
  await page.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.waitForFunction(
    () => window.__mahjong && window.__mahjong.ui && !document.getElementById('app').hidden,
    { timeout: 20000 }
  );
  await sleep(2500); // 等发牌动画
}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
      '--no-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });

  let fails = 0;
  const check = (name, ok, detail) => {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!ok) fails++;
  };

  /* ---------- 用例 1：3D 路径 · 竖屏手机（390x844 旋转 90°） ---------- */
  {
    const page = await browser.newPage();
    await page.emulate({
      viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await enterTable(page, BASE);

    const is3D = await page.evaluate(() => window.__mjTable3d && window.__mjTable3d.is3D);
    check('3D 已挂载', is3D);

    // 等到本人出牌回合
    await page.waitForFunction(() => !!window.__mahjong.ui.handClickResolve, { timeout: 30000 });
    await sleep(400);

    // 计算第 2 张手牌的屏幕坐标：世界 → NDC → canvas 逻辑像素 → 旋转逆变换 → 屏幕
    const pos = await page.evaluate((idx) => {
      const t3 = window.__mahjong.ui.t3d;
      const cv = t3.renderer.domElement;
      const mesh = t3.groups[0].hand.children[idx];
      if (!mesh) return { err: 'no mesh' };
      // 用 camera 的矩阵手动投影（Vector3 构造器从 position 原型取）
      const wp = new (Object.getPrototypeOf(t3.camera.position).constructor)(0, 0, 0);
      mesh.getWorldPosition(wp);
      const v = wp.clone();
      v.project(t3.camera); // NDC
      const lw = cv.offsetWidth, lh = cv.offsetHeight; // 逻辑尺寸
      const lx = (v.x * 0.5 + 0.5) * lw;
      const ly = (-v.y * 0.5 + 0.5) * lh;
      // canvas 逻辑坐标 → 屏幕（逆 _canvasLocal）
      const r = cv.getBoundingClientRect();
      const app = document.getElementById('app');
      let deg = 0;
      const tr = getComputedStyle(app).transform;
      if (tr && tr !== 'none') {
        const m = tr.match(/matrix(?:3d)?\(([^)]+)\)/);
        if (m) {
          const parts = m[1].split(',').map(parseFloat);
          if (m[0].startsWith('matrix3d')) deg = Math.round(Math.atan2(parts[1], parts[0]) * 180 / Math.PI);
          else deg = Math.round(Math.atan2(parts[1], parts[0]) * 180 / Math.PI);
        }
      }
      const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
      // 逆变换（与 _canvasLocal 对偶）：逻辑偏移 u=lx-lw/2, v=ly-lh/2；
      // deg=90: 物理(dx,dy)=(-v,u) → sx = cx-(ly-lh/2), sy = cy+(lx-lw/2)
      let sx, sy;
      if (deg === 90) { sx = cx - (ly - lh / 2); sy = cy + (lx - lw / 2); }
      else if (deg === -90 || deg === 270) { sx = cx + (ly - lh / 2); sy = cy - (lx - lw / 2); }
      else if (deg === 180) { sx = cx - (lx - lw / 2); sy = cy - (ly - lh / 2); }
      else { sx = cx + (lx - lw / 2); sy = cy + (ly - lh / 2); }
      return { sx, sy, deg, lw, lh, rect: { w: r.width, h: r.height }, transform: tr ? tr.slice(0, 60) : 'none' };
    }, 2);

    check('手牌投影计算', pos && !pos.err, JSON.stringify(pos && pos.err ? pos : { deg: pos.deg, lw: pos.lw, lh: pos.lh, rect: pos.rect, transform: (pos.transform || '').slice(0, 40) }));

    if (pos && pos.sx !== undefined) {
      // 命中检测：该屏幕点最顶层元素是不是 canvas
      const topEl = await page.evaluate((x, y) => {
        const el = document.elementFromPoint(x, y);
        return el ? (el.tagName + '#' + (el.id || '') + '.' + (el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className || '')).slice(0, 60) : 'null';
      }, pos.sx, pos.sy);

      // 真实触摸：第一击选中
      await page.touchscreen.tap(pos.sx, pos.sy);
      await sleep(500);
      const sel1 = await page.evaluate(() => window.__mahjong.ui.selectedTile);
      check('触摸第一击 → 选中手牌', sel1 !== null && sel1 !== undefined, `selectedTile=${sel1} topEl=${topEl}`);

      // 第二击同牌 → 出牌
      await page.touchscreen.tap(pos.sx, pos.sy);
      await sleep(1800); // 等飞行动画
      const after = await page.evaluate(() => ({
        hand: window.__mjTable3d.handCount(0),
        river: window.__mjTable3d.riverCount(0),
        pending: window.__mjTable3d.pendingCount(),
      }));
      check('触摸第二击 → 出牌', after.river >= 1 || after.pending > 0, JSON.stringify(after));
    }

    check('零页面脚本错误(3D)', errors.length === 0, errors.slice(0, 3).join(' | '));
    await page.close();
  }

  /* ---------- 用例 2：DOM 路径 · 竖屏手机（?ui=dom） ---------- */
  {
    const page = await browser.newPage();
    await page.emulate({
      viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await enterTable(page, BASE + '?ui=dom');

    const is3D = await page.evaluate(() => window.__mjTable3d && window.__mjTable3d.is3D);
    check('DOM 模式确认', !is3D);

    await page.waitForFunction(() => !!window.__mahjong.ui.handClickResolve, { timeout: 30000 });
    await sleep(400);

    // DOM 牌块：取第 2 张的屏幕位置（旋转布局下 boundingBox 是屏幕盒，tap 用屏幕坐标）
    const tileInfo = await page.evaluate(() => {
      const els = document.querySelectorAll('#my-hand .tile');
      if (els.length < 3) return { err: 'tiles=' + els.length };
      const el = els[2];
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, n: els.length };
    });
    check('DOM 手牌定位', !tileInfo.err, tileInfo.err || `n=${tileInfo.n}`);

    if (!tileInfo.err) {
      await page.touchscreen.tap(tileInfo.x, tileInfo.y);
      await sleep(500);
      const sel1 = await page.evaluate(() => window.__mahjong.ui.selectedTile);
      check('DOM 触摸第一击 → 选中', sel1 !== null && sel1 !== undefined, `selectedTile=${sel1}`);

      await page.touchscreen.tap(tileInfo.x, tileInfo.y);
      await sleep(800);
      const after = await page.evaluate(() => ({
        hand: window.__mahjong.ui.engine.players[0].hand.length,
        river: window.__mahjong.ui.engine.players[0].discards.length,
      }));
      check('DOM 触摸第二击 → 出牌', after.river >= 1, JSON.stringify(after));
    }

    check('零页面脚本错误(DOM)', errors.length === 0, errors.slice(0, 3).join(' | '));
    await page.close();
  }

  /* ---------- 用例 3：操作栏按钮触摸（3D） ---------- */
  {
    const page = await browser.newPage();
    await page.emulate({
      viewport: { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 3 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
    await enterTable(page, BASE);
    await page.waitForFunction(() => !!window.__mahjong.ui.handClickResolve, { timeout: 30000 });
    // 注入一个必然出现的「过」按钮场景：直接调 showActions 并用 tap 点它
    await page.evaluate(() => {
      window.__mahjong.ui.showActions([{ label: '吃', value: 'chi' }, { label: '过', value: 'pass', cls: 'pass' }], 0);
    });
    await sleep(300);
    const pass = await page.$('#action-bar .act-btn.pass');
    const bb = await pass.boundingBox();
    check('操作栏按钮可见', !!bb && bb.width > 0, bb ? `${Math.round(bb.width)}x${Math.round(bb.height)} @${Math.round(bb.x)},${Math.round(bb.y)}` : 'null');
    if (bb) {
      await page.touchscreen.tap(bb.x + bb.width / 2, bb.y + bb.height / 2);
      await sleep(400);
      const gone = await page.evaluate(() => {
        const bar = document.getElementById('action-bar');
        return bar.classList.contains('hidden');
      });
      check('触摸操作栏「过」→ 关闭', gone);
    }
    await page.close();
  }

  await browser.close();
  console.log(fails === 0 ? '\n=== 移动端触摸全部通过 ===' : `\n=== ${fails} 项失败 ===`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
