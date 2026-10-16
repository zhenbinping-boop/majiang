/* 全场景牌块 AABB 重叠探针：真实推进 ~18 个人类回合后，
   对牌河/副露/AI 手牌/我方手牌做两两世界包围盒相交检测，报告穿模对。 */
const puppeteer = require('puppeteer-core');
const path = require('path');
const { pickChip } = require('./helpers');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = 'http://127.0.0.1:8765/index.html';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHumanDiscard(page, timeout = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const st = await page.evaluate(() => {
      const bar = document.getElementById('action-bar');
      const barVisible = !!bar && !bar.classList.contains('hidden');
      return { barVisible };
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
    const ready = await page.evaluate(() => !!window.__mahjong.ui.handClickResolve);
    if (ready) return true;
    await sleep(200);
  }
  return false;
}

async function humanDiscardLast(page) {
  const clickLast = () => page.evaluate(() => {
    const d3 = window.__mjTable3d;
    if (d3 && d3.is3D) return d3.clickHandTile(d3.handCount(0) - 1);
    return false;
  });
  await clickLast();
  await sleep(250);
  await clickLast();
  await page.waitForFunction(() => {
    const d3 = window.__mjTable3d;
    return !d3 || !d3.is3D || d3.pendingCount() === 0;
  }, { timeout: 5000, polling: 80 }).catch(() => {});
  await sleep(350);
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
  await sleep(600);
  const btn = await page.$('#btn-quick');
  const bb = await btn.boundingBox();
  await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.waitForFunction(() => window.__mahjong && window.__mahjong.ui &&
    !document.getElementById('app').hidden, { timeout: 20000 });
  await pickChip(page);   // 拿牌后选筹码弹窗
  await sleep(2500);

  // 推进 18 个回合（让牌河涨到 2~3 行、副露出现）
  const TURNS = 18;
  for (let i = 0; i < TURNS; i++) {
    const ok = await waitHumanDiscard(page);
    if (!ok) { console.log(`turn ${i}: 等待超时（可能已终局），提前结束`); break; }
    await humanDiscardLast(page);
  }
  await sleep(1000);

  const report = await page.evaluate(() => {
    const t3 = window.__mahjong.ui.t3d;
    if (!t3) return { err: 'no t3d' };
    const V3 = t3.camera.position.constructor; // Vector3 类
    const boxOf = (obj) => {
      // 世界 AABB：合并 mesh 自身几何包围盒（经矩阵变换 8 角点）
      obj.updateWorldMatrix(true, false);
      const g = obj.geometry || (obj.userData.body && obj.userData.body.geometry);
      if (!g) return null;
      if (!g.boundingBox) g.computeBoundingBox();
      const b = g.boundingBox, out = {
        min: new V3(), max: new V3(),
      };
      const m = obj.matrixWorld;
      const corners = [
        [b.min.x, b.min.y, b.min.z], [b.max.x, b.min.y, b.min.z],
        [b.min.x, b.max.y, b.min.z], [b.max.x, b.max.y, b.min.z],
        [b.min.x, b.min.y, b.max.z], [b.max.x, b.min.y, b.max.z],
        [b.min.x, b.max.y, b.max.z], [b.max.x, b.max.y, b.max.z],
      ];
      corners.forEach((c, k) => {
        const v = new V3(c[0], c[1], c[2]).applyMatrix4(m);
        if (k === 0) { out.min.copy(v); out.max.copy(v); }
        else {
          out.min.min(v); out.max.max(v);
        }
      });
      return out;
    };
    const hit = (a, b) => a.min.x < b.max.x && a.max.x > b.min.x &&
      a.min.y < b.max.y && a.max.y > b.min.y &&
      a.min.z < b.max.z && a.max.z > b.min.z;

    const items = [];
    const KIND = { hand: '手牌', river: '牌河', meld: '副露' };
    for (let pid = 0; pid < 4; pid++) {
      for (const kind of ['hand', 'river', 'meld']) {
        const grp = t3.groups[pid][kind];
        grp.children.forEach((mesh, i) => {
          if (!mesh.visible) return;
          const bb = boxOf(mesh);
          if (bb) items.push({ pid, kind, i, bb, mesh });
        });
      }
    }
    const pairs = [];
    const EPS = 0.015; // 允许的接触容差
    for (let a = 0; a < items.length; a++) {
      for (let b = a + 1; b < items.length; b++) {
        const A = items[a], B = items[b];
        if (A.pid === B.pid && A.kind === B.kind && A.kind === 'hand') continue; // 我方立牌斜置的 AABB 天然放大，组内跳过
        const x = Math.min(A.bb.max.x, B.bb.max.x) - Math.max(A.bb.min.x, B.bb.min.x);
        const y = Math.min(A.bb.max.y, B.bb.max.y) - Math.max(A.bb.min.y, B.bb.min.y);
        const z = Math.min(A.bb.max.z, B.bb.max.z) - Math.max(A.bb.min.z, B.bb.min.z);
        if (x > EPS && y > EPS && z > EPS) {
          pairs.push({
            a: `${A.pid}:${KIND[A.kind]}#${A.i}`,
            b: `${B.pid}:${KIND[B.kind]}#${B.i}`,
            depth: [+x.toFixed(3), +y.toFixed(3), +z.toFixed(3)],
          });
        }
      }
    }
    const counts = {};
    for (let pid = 0; pid < 4; pid++) {
      counts[pid] = {
        hand: t3.groups[pid].hand.children.length,
        river: t3.groups[pid].river.children.length,
        meld: t3.groups[pid].meld.children.length,
      };
    }
    /* 实际脚印尺寸：每类第一张的世界 bbox 尺寸 */
    const sizes = {};
    for (let pid = 0; pid < 4; pid++) {
      for (const kind of ['hand', 'river', 'meld']) {
        const grp = t3.groups[pid][kind];
        if (grp.children.length && !sizes[kind]) {
          const bb = boxOf(grp.children[0]);
          if (bb) sizes[kind + ':' + pid] = {
            x: +(bb.max.x - bb.min.x).toFixed(3),
            y: +(bb.max.y - bb.min.y).toFixed(3),
            z: +(bb.max.z - bb.min.z).toFixed(3),
          };
        }
      }
    }
    /* 副露内部：沿座线的最小间隙（用中心点在 TAN 方向的投影） */
    const meldGaps = {};
    for (let pid = 0; pid < 4; pid++) {
      const grp = t3.groups[pid].meld;
      if (grp.children.length < 2) continue;
      const t = [[{ x: 1, z: 0 }][0], { x: 0, z: 1 }][0]; // 占位，下面直接用世界坐标距离
      const items = grp.children.map((mesh, i) => {
        const bb = boxOf(mesh);
        const v = new V3(); mesh.getWorldPosition(v);
        return { i, cx: v.x, cz: v.z, bb };
      });
      // 找最近的两张：中心距 - 半径和
      let worst = null;
      for (let a = 0; a < items.length; a++) {
        for (let b = a + 1; b < items.length; b++) {
          const A = items[a], B = items[b];
          const dx = A.cx - B.cx, dz = A.cz - B.cz;
          const dist = Math.hypot(dx, dz);
          if (!worst || dist < worst.dist) worst = { a: A.i, b: B.i, dist: +dist.toFixed(3) };
        }
      }
      meldGaps[pid] = worst;
    }
    /* 副露 vs 牌河 / 副露 vs 手牌 交叉对单独列出 */
    const cross = pairs.filter((p) => {
      const ka = p.a.split(':')[1], kb = p.b.split(':')[1];
      return !(ka === '牌河' && kb === '牌河' && p.a.split(':')[0] === p.b.split(':')[0]);
    });
    return { counts, sizes, meldGaps, crossPairs: cross.slice(0, 20), riverPairSample: pairs.slice(0, 4), total: items.length };
  });

  console.log(JSON.stringify(report, null, 1));
  require('fs').mkdirSync('shots', { recursive: true });
  await page.screenshot({ path: 'shots/diag-overlap.png' });
  await browser.close();
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
