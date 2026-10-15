/**
 * probe-fit.js — 相机取景约束扫描：coversScreen / handFits 随相机距离的真值表
 */
const puppeteer = require('puppeteer-core');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:8765/index.html';

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
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => window.__mjHome && document.getElementById('btn-quick'), { timeout: 20000, polling: 60 });
  await page.evaluate(() => document.getElementById('btn-quick').click());
  await page.waitForFunction(() => {
    const d = window.__mjTable3d;
    return d && d.is3D && d.handCount(0) >= 13;
  }, { timeout: 30000, polling: 100 });
  await new Promise((r) => setTimeout(r, 900));

  const sweep = await page.evaluate(() => {
    const t = window.__mahjong.ui.t3d;
    const T3 = window.THREE;
    const dir = new T3.Vector3(0, 0.94, 0.72).normalize();
    const target = new T3.Vector3(0, 0, 1.2);
    const cam = t.camera;
    const HAND_Z = 17.34, TILE_D = 1.6, TILE_H = 3.0, TILE_W = 2.2;
    const HAND_PITCH = TILE_W + 0.34, DRAW_GAP = 0.4;
    const FR = HAND_Z + 5.5 + 2.4;
    const feltPts = [
      new T3.Vector3(-FR, 0, -FR), new T3.Vector3(FR, 0, -FR),
      new T3.Vector3(FR, 0, FR), new T3.Vector3(-FR, 0, FR),
    ];
    const span = (13 / 2) * HAND_PITCH + DRAW_GAP + TILE_W;
    const handPts = [
      new T3.Vector3(-span, 0, HAND_Z + TILE_D), new T3.Vector3(span, 0, HAND_Z + TILE_D),
      new T3.Vector3(-span, TILE_H + 0.6, HAND_Z), new T3.Vector3(span, TILE_H + 0.6, HAND_Z),
    ];
    const v = new T3.Vector3();
    const proj = (p, dist) => {
      cam.position.copy(target).addScaledVector(dir, dist);
      cam.lookAt(target);
      cam.updateMatrixWorld();
      v.copy(p).project(cam);
      return { x: v.x, y: v.y, z: v.z };
    };
    const covers = (dist) => {
      const q = feltPts.map((p) => proj(p, dist));
      for (const sx of [-1.02, 1.02]) for (const sy of [-1.02, 1.02]) {
        let pos = false, neg = false;
        for (let i = 0; i < 4; i++) {
          const a = q[i], b = q[(i + 1) % 4];
          const c = (b.x - a.x) * (sy - a.y) - (b.y - a.y) * (sx - a.x);
          if (c > 1e-9) pos = true; else if (c < -1e-9) neg = true;
        }
        if (pos && neg) return false;
      }
      return true;
    };
    const handOk = (dist) => {
      for (const p of handPts) {
        const n = proj(p, dist);
        if (n.x < -0.985 || n.x > 0.985 || n.y < -0.985 || n.y > 0.985) return false;
      }
      return true;
    };
    const rows = [];
    for (const d of [14, 16, 18, 20, 22, 24, 26, 28, 30, 33, 36, 40, 45, 50, 60, 80]) {
      const cn = covers(d), hn = handOk(d);
      const c0 = proj(feltPts[0], d);
      rows.push({ d, covers: cn, hand: hn, cornerNdc: [+c0.x.toFixed(2), +c0.y.toFixed(2), +c0.z.toFixed(2)] });
    }
    return { fov: cam.fov, aspect: +cam.aspect.toFixed(3), rows };
  });
  console.log('fov=' + sweep.fov, 'aspect=' + sweep.aspect);
  for (const r of sweep.rows) {
    console.log(`d=${String(r.d).padStart(3)} covers=${r.covers ? 'Y' : 'n'} hand=${r.hand ? 'Y' : 'n'}  feltC0.ndc=(${r.cornerNdc.join(',')})`);
  }
  await browser.close();
})().catch((e) => { console.error('PROBE-ERROR:', e.message); process.exit(1); });
