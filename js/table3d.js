/**
 * table3d.js — Three.js 真 3D 牌桌渲染器（HUD 2D 浮层 + 3D 立体场景）
 *
 * 职责：
 *   ① 3D 麻将桌台：深蓝绒布桌面 + 鎏金木质边框 + 中央八角电子风位罗盘
 *      （罗盘整体绘制在 512×512 CanvasTexture 上：中心局数/余牌 + 四内缘座风，
 *       当前行动家鎏金高亮 + 指示灯点亮 —— 所有文字同一平面，绝不重叠）
 *   ② 真六面体一体成型麻将块：正面牌面 CanvasTexture / 侧面象牙 / 背面朱红
 *   ③ 雀魂式三维布局：牌河 6×3（四角零重叠）/ 手牌与副露同一条桌沿基准线
 *      （手牌居左、副露向右手角平铺，总长恒 ≤ 14 张，永不穿模）
 *   ④ 纯麻将块补间动画（无手部模型）：摸牌 180ms 上方落入 / 出牌 220ms 抛物线
 *      飞入牌河 + 金色波纹 / 吃碰杠 220ms 副露聚拢就位
 *   ⑤ Raycaster 射线选牌（我方手牌：悬停升起 / 单击选中 / 再击出牌）
 *
 * 降级：无 WebGL / 构造异常时 mount() 返回 null，ui.js 自动回退平面 DOM 渲染。
 * 坐标系：与「横屏逻辑视口」一致 —— 画布在 #app 旋转容器内按布局尺寸工作，
 *         竖屏时 CSS 旋转由外层完成，Three 只需按容器逻辑宽高 setSize。
 * 世界系：相机在 (0, +Y, +Z) 朝向桌心 ⇒ 屏幕左 = -X、右 = +X；
 *         Seat 0=我(南,+Z) 1=右家(东,+X) 2=对家(北,-Z) 3=左家(西,-X)。
 */
(function (global) {
  'use strict';

  const T = global.THREE;
  if (!T) return;

  /* ================= 常量（雀魂式比例基准） ================= */
  const TILE_W = 1.15, TILE_H = 1.56, TILE_D = 0.82;  // 宽:长:厚（世界单位）
  const GAP = 0.06;                                    // 牌间微缝
  const TILE_R = 0.13, BEVEL = 0.04;                   // 圆角与倒角

  const RIVER_COLS = 6, RIVER_ROWS = 3;
  const RX = TILE_W + GAP;                             // 1.21 —— 行内步进
  const RZ = TILE_H + GAP;                             // 1.62 —— 换行步进
  const R_COMPASS = 2.5;                               // 中央罗盘外径
  const R_RIVER = 4.45;                                // 牌河第 1 行中心距桌心
                                                       //（> 行半宽 3.63，且经对角
                                                       //   分离轴验证四角零重叠）
  const R_HAND = 9.6;                                  // 手牌/副露桌沿基准线
  const HAND_PITCH = TILE_W + GAP;                     // 手牌步进
  const DRAW_GAP = 0.35 * TILE_W;                      // 摸牌自动留出的间距
  const MELD_GAP = 0.6;                                // 手牌段与副露段间距
  const GROUP_GAP = 0.3;                               // 副露组间距

  const COL = {
    felt: 0x061528, feltHi: 0x0a2140,
    wood: 0x6d4a22, gold: 0xd8b46c,
    ivory: 0xf5eedc, shell: 0x9b2d1f,
    compass: 0x0a0f26, compassRim: 0xd8b46c,
  };

  /* 座位几何（相机视角）：0=我(南,屏幕下) 1=右家(东,右) 2=对家(北,上) 3=左家(西,左) */
  const SEAT_DIR = [                      // 桌心 → 座位（向外）单位向量
    { x: 0, z: 1 }, { x: 1, z: 0 }, { x: 0, z: -1 }, { x: -1, z: 0 },
  ];
  const SEAT_YAW = [0, Math.PI / 2, Math.PI, -Math.PI / 2];  // 立牌/平铺字朝向
  /** 各家自身视角的「右手」方向：手牌从左到右升序 = 沿此方向递增；
      牌河行内从其左手到右手 = 同一方向；换行向 +SEAT_DIR（靠近自身）推进 */
  const TAN = [
    { x: 1, z: 0 }, { x: 0, z: -1 }, { x: -1, z: 0 }, { x: 0, z: 1 },
  ];

  /* ================= 小工具 ================= */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOutQuad = (t) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

  /* ---- 微型补间系统（RAF 驱动） ---- */
  const tweens = [];
  function tween(dur, onUpdate, opts) {
    opts = opts || {};
    const tw = {
      t0: performance.now() + (opts.delay || 0),
      dur, onUpdate, onDone: opts.onDone || null,
      ease: opts.ease || easeOutCubic, dead: false,
      tag: opts.tag || null,
    };
    tweens.push(tw);
    return tw;
  }
  function stepTweens(now) {
    for (let i = tweens.length - 1; i >= 0; i--) {
      const tw = tweens[i];
      if (tw.dead) { tweens.splice(i, 1); continue; }
      if (now < tw.t0) continue;
      const k = clamp((now - tw.t0) / tw.dur, 0, 1);
      tw.onUpdate(tw.ease(k), k);
      if (k >= 1) { tweens.splice(i, 1); if (tw.onDone) tw.onDone(); }
    }
  }
  function killTweensOf(tag) {
    for (const tw of tweens) if (tw.tag === tag) tw.dead = true;
  }

  function webglAvailable() {
    try {
      const c = document.createElement('canvas');
      return !!(global.WebGLRenderingContext &&
        (c.getContext('webgl') || c.getContext('experimental-webgl')));
    } catch (e) { return false; }
  }

  /* ================= 几何构建 ================= */

  /** 圆角矩形 Shape（局部中心对称） */
  function roundedRectShape(w, h, r) {
    const s = new T.Shape();
    const x = -w / 2, y = -h / 2;
    s.moveTo(x + r, y);
    s.lineTo(x + w - r, y);       s.quadraticCurveTo(x + w, y, x + w, y + r);
    s.lineTo(x + w, y + h - r);   s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    s.lineTo(x + r, y + h);       s.quadraticCurveTo(x, y + h, x, y + h - r);
    s.lineTo(x, y + r);           s.quadraticCurveTo(x, y, x + r, y);
    return s;
  }

  function extrudeRounded(w, h, r, depth, bevel) {
    const geo = new T.ExtrudeGeometry(roundedRectShape(w, h, r), {
      depth, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel,
      bevelSegments: 3, curveSegments: 6,
    });
    geo.computeVertexNormals();
    return geo;
  }

  /* ---- 麻将块几何（共享，单几何三材质组：正面牌面 / 侧面象牙 / 背面朱红） ----
     局部坐标系约定：+z = 花色正面（CanvasTexture）、-z = 红/绿牌背、
     ±x / ±y = 象牙侧壁；平躺亮面 = R_x(-90°)，之后只绕世界 Y 轴旋转 ——
     绝不绕 X/Z 翻 90°，杜绝把纯白侧面翻到上面变成「白块」。 */
  let _tileGeo = null;
  function tileGeo() {
    if (_tileGeo) return _tileGeo;
    const geo = extrudeRounded(TILE_W, TILE_H, TILE_R, TILE_D - BEVEL * 2, BEVEL);
    const pos = geo.attributes.position, nor = geo.attributes.normal, uv = geo.attributes.uv;
    // 正面（含倒角上半段）UV 归一到 0..1，供牌面贴图使用
    for (let i = 0; i < uv.count; i++) {
      if (nor.getZ(i) > 0.5) {
        uv.setXY(i, pos.getX(i) / TILE_W + 0.5, pos.getY(i) / TILE_H + 0.5);
      }
    }
    // 按三角形平均法线把顶点分桶：正面 / 侧面 / 背面
    const front = [], side = [], back = [];
    for (let t = 0; t < pos.count; t += 3) {
      const nz = (nor.getZ(t) + nor.getZ(t + 1) + nor.getZ(t + 2)) / 3;
      const key = nz > 0.5 ? front : (nz < -0.5 ? back : side);
      key.push(t, t + 1, t + 2);
    }
    const order = front.concat(side, back);
    const n = pos.count;
    const np = new Float32Array(n * 3), nn = new Float32Array(n * 3), nu = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const s = order[i];
      np[i * 3] = pos.getX(s); np[i * 3 + 1] = pos.getY(s); np[i * 3 + 2] = pos.getZ(s);
      nn[i * 3] = nor.getX(s); nn[i * 3 + 1] = nor.getY(s); nn[i * 3 + 2] = nor.getZ(s);
      nu[i * 2] = uv.getX(s); nu[i * 2 + 1] = uv.getY(s);
    }
    geo.setAttribute('position', new T.BufferAttribute(np, 3));
    geo.setAttribute('normal', new T.BufferAttribute(nn, 3));
    geo.setAttribute('uv', new T.BufferAttribute(nu, 2));
    geo.clearGroups();
    geo.addGroup(0, front.length, 0);                 // 正面 → 牌面贴图
    geo.addGroup(front.length, side.length, 1);       // 侧面 → 象牙
    geo.addGroup(front.length + side.length, back.length, 2);  // 背面 → 朱红壳
    _tileGeo = geo;
    return geo;
  }

  /* ================= 纹理 ================= */

  /** 34 种牌面 CanvasTexture 缓存（SVG → 离屏 canvas 512×696 高清） */
  const faceTexCache = new Map();
  function faceTexture(tileIndex, MJ) {
    let tex = faceTexCache.get(tileIndex);
    if (tex) return tex;
    const cw = 512, ch = 696;
    const cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    const g = cv.getContext('2d');
    g.fillStyle = '#f6efdd';
    g.fillRect(0, 0, cw, ch);
    // 浅凹内阴影（模拟阴刻凹槽）
    g.strokeStyle = 'rgba(120,96,60,.20)';
    g.lineWidth = 12;
    g.strokeRect(18, 18, cw - 36, ch - 36);
    g.strokeStyle = 'rgba(255,255,255,.55)';
    g.lineWidth = 4;
    g.strokeRect(26, 26, cw - 52, ch - 52);
    const svg = MJ.tileFaceSVG(tileIndex);
    const img = new Image();
    tex = new T.CanvasTexture(cv);
    tex.anisotropy = 8;
    tex.encoding = T.sRGBEncoding;
    tex._ready = false;
    img.onload = () => {
      g.drawImage(img, 28, 28, cw - 56, ch - 56);
      tex.needsUpdate = true;
      tex._ready = true;
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    faceTexCache.set(tileIndex, tex);
    return tex;
  }

  /* ================= 麻将块 Mesh ================= */

  /**
   * 一体成型麻将块（单 Mesh 三材质组，无分层接缝）。
   * local：+z 为牌面法线、-z 为牌背、+y 为牌面「上」方向。
   */
  function makeTile(tileIndex, mats, MJ) {
    const m = new T.Mesh(tileGeo(), [mats.face(tileIndex), mats.sideIvory, mats.sideShell]);
    m.castShadow = true; m.receiveShadow = true;
    m.userData.tileIndex = tileIndex;
    m.userData.body = m;      // 兼容旧接口（emissive 高亮走 body.material[0]）
    return m;
  }

  /** 平躺（牌面朝上、字朝 pid 自己）：R_y(yaw)·R_x(-90°)，yaw 只绕世界 Y */
  const _qTmp = new T.Quaternion(), _qFlat = new T.Quaternion(), _qYaw = new T.Quaternion();
  const _eX = new T.Euler(), _AXIS_Y = new T.Vector3(0, 1, 0);
  function flatQuat(yaw) {
    _eX.set(-Math.PI / 2, 0, 0);
    _qFlat.setFromEuler(_eX);
    _qYaw.setFromAxisAngle(_AXIS_Y, yaw);
    return _qTmp.copy(_qYaw).multiply(_qFlat).clone();
  }
  const FLAT_QUATS = SEAT_YAW.map(flatQuat);

  /* 我方手牌立牌姿态：牌面法线精确指向基准机位 —— 俯视相机下完全可读（2D 观感） */
  const CAM_BASE_POS = new T.Vector3(0, 20.25, 15.89);   // _fitCamera 基准机位（k=0.9）
  const MY_LOOK = new T.Vector3(
    0, CAM_BASE_POS.y - TILE_H / 2, CAM_BASE_POS.z - (R_HAND + TILE_D / 2)).normalize();
  const MY_STAND_QUAT = new T.Quaternion().setFromUnitVectors(new T.Vector3(0, 0, 1), MY_LOOK);
  /* AI 立牌：牌背朝桌心并整体上仰 35°（顶向桌外倾），高机位下红背清晰可见 */
  const AI_TILT = 35 * Math.PI / 180;
  const AI_STAND_QUATS = SEAT_DIR.map((d) => {
    const c = Math.cos(AI_TILT), s = Math.sin(AI_TILT);
    const F = new T.Vector3(d.x * c, -s, d.z * c);      // 牌面法线（微朝下）
    const U = new T.Vector3(d.x * s, c, d.z * s);       // 牌顶方向（向桌外倾）
    const X = new T.Vector3().crossVectors(U, F);
    return new T.Quaternion().setFromRotationMatrix(new T.Matrix4().makeBasis(X, U, F));
  });
  function aiStandQuat(pid) { return AI_STAND_QUATS[pid]; }

  /* ================= 主类 ================= */

  class Table3D {
    constructor(container, MJ, opts) {
      this.MJ = MJ;
      this.container = container;
      this.opts = opts || {};
      this.destroyed = false;

      /* ---- 渲染器 ---- */
      this.renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
      this.renderer.setPixelRatio(clamp(global.devicePixelRatio || 1, 1, 2));
      this.renderer.outputEncoding = T.sRGBEncoding;
      this.renderer.shadowMap.enabled = true;
      this.renderer.shadowMap.type = T.PCFSoftShadowMap;
      this.renderer.domElement.id = 'table-3d';
      // 内联定位样式：绝对铺满容器（内联优先级最高，避免任何级联意外）
      const cv = this.renderer.domElement;
      cv.style.position = 'absolute';
      cv.style.inset = '0';
      cv.style.width = '100%';
      cv.style.height = '100%';
      cv.style.display = 'block';
      cv.style.zIndex = '0';
      container.insertBefore(cv, container.firstChild);

      /* ---- 场景 ---- */
      this.scene = new T.Scene();
      this.scene.fog = new T.Fog(0x05070f, 70, 160);

      this.camera = new T.PerspectiveCamera(40, 1, 0.1, 400);
      this.camShake = 0;

      /* 布局缓存：手牌 / 副露同一条桌沿基准线的联合排版 */
      this._handInfo = {};      // pid → { count, fresh }
      this._meldInfo = {};      // pid → { total }
      this._pulsePid = -1;      // 待播放「副露聚拢」动画的座位
      this._pending = {};
      /* 罗盘状态 */
      this._compassTurn = 0;
      this._compassL1 = '';
      this._compassL2 = '';
      this._compassWinds = null;

      this._buildLights();
      this._buildTable();
      this._buildCompass();
      this._buildGroups();
      this._buildCursor();

      /* ---- 材质库 ---- */
      const sideIvory = new T.MeshStandardMaterial({ color: COL.ivory, roughness: 0.38, metalness: 0.03 });
      const sideShell = new T.MeshStandardMaterial({ color: COL.shell, roughness: 0.3, metalness: 0.06 });
      const faceMatCache = new Map();
      this.mats = {
        sideIvory, sideShell,
        face: (idx) => {
          let m = faceMatCache.get(idx);
          if (!m) {
            m = new T.MeshStandardMaterial({
              map: faceTexture(idx, MJ), roughness: 0.34, metalness: 0.03,
            });
            faceMatCache.set(idx, m);
          }
          return m;
        },
      };
      this._faceMats = faceMatCache;

      /* ---- 选牌交互 ---- */
      this.ray = new T.Raycaster();
      this.ndc = new T.Vector2();
      this.hoverIdx = -1;
      this.selectedIdx = -1;
      this.onPickTile = null;      // (idx, tileIndex) => void  （再次点击同张 = 出牌）
      this.onHoverTile = null;     // (idx|null, tileIndex|null) => void
      this._bindPointer();

      /* ---- 视口 ---- */
      this._onResize = () => this.resize();
      global.addEventListener('resize', this._onResize, { passive: true });
      this.resize();

      /* ---- 帧循环 ---- */
      this._raf = () => {
        if (this.destroyed) return;
        requestAnimationFrame(this._raf);
        const now = performance.now();
        stepTweens(now);
        this._tick(now);
        this.renderer.render(this.scene, this.camera);
      };
      requestAnimationFrame(this._raf);
    }

    /* ---------- 场景搭建 ---------- */
    _buildLights() {
      const hemi = new T.HemisphereLight(0xbfd8ff, 0x3a2a18, 0.6);
      this.scene.add(hemi);
      const spot = new T.SpotLight(0xfff2dc, 1.1, 160, Math.PI / 3.4, 0.45, 1.2);
      spot.position.set(5, 30, 9);
      spot.castShadow = true;
      spot.shadow.mapSize.set(2048, 2048);
      spot.shadow.bias = -0.0006;
      this.scene.add(spot);
      this.scene.add(spot.target);
      const warm = new T.PointLight(0xffd9a0, 0.55, 60);
      warm.position.set(0, 9, 11);
      this.scene.add(warm);
    }

    _buildTable() {
      // 绒布桌面（大圆角矩形：足够覆盖任何宽高比下的相机视锥落地面）
      const FW = 76, FD = 46, ZC = -4;
      const feltGeo = extrudeRounded(FW, FD, 4, 0.8, 0.3);
      feltGeo.rotateX(-Math.PI / 2);
      const felt = new T.Mesh(feltGeo, new T.MeshStandardMaterial({
        color: COL.felt, roughness: 0.95, metalness: 0,
      }));
      felt.position.set(0, -0.8, ZC);
      felt.receiveShadow = true;
      this.scene.add(felt);
      // 中心的亮一圈（渐变高光贴片）
      const hi = new T.Mesh(
        new T.CircleGeometry(9, 48),
        new T.MeshBasicMaterial({ color: COL.feltHi, transparent: true, opacity: 0.32 }));
      hi.rotation.x = -Math.PI / 2;
      hi.position.y = 0.012;
      this.scene.add(hi);
      // 鎏金木质边框（四条）
      const woodMat = new T.MeshStandardMaterial({ color: COL.wood, roughness: 0.42, metalness: 0.25 });
      const rimMat = new T.MeshStandardMaterial({ color: COL.gold, roughness: 0.3, metalness: 0.6 });
      const bw = 1.7, bh = 1.1;
      const hx = FW / 2 + bw / 2;
      const zN = ZC - (FD / 2 + bw / 2), zS = ZC + (FD / 2 + bw / 2);
      [[0, zN, FW + bw * 2, bw], [0, zS, FW + bw * 2, bw]].forEach(([x, z, w, d]) => {
        const m = new T.Mesh(new T.BoxGeometry(w, bh, d), woodMat);
        m.position.set(x, bh / 2 - 0.9, z);
        m.castShadow = true; m.receiveShadow = true;
        this.scene.add(m);
        const trim = new T.Mesh(new T.BoxGeometry(w * 0.99, 0.2, 0.3), rimMat);
        trim.position.set(x, bh - 0.72, z + (z > ZC ? -d / 2 - 0.05 : d / 2 + 0.05));
        this.scene.add(trim);
      });
      [[-hx, ZC, bw, FD], [hx, ZC, bw, FD]].forEach(([x, z, w, d]) => {
        const m = new T.Mesh(new T.BoxGeometry(w, bh, d), woodMat);
        m.position.set(x, bh / 2 - 0.9, z);
        m.castShadow = true; m.receiveShadow = true;
        this.scene.add(m);
        const trim = new T.Mesh(new T.BoxGeometry(0.3, 0.2, d * 0.99), rimMat);
        trim.position.set(x + (x > 0 ? -w / 2 - 0.05 : w / 2 + 0.05), bh - 0.72, z);
        this.scene.add(trim);
      });
    }

    /* ---- 中央八角罗盘：整体绘制在 512×512 CanvasTexture 上 ----
       中心圆盘两行（局数 / 余牌）+ 四内缘扇区座风字（各自朝向对应座位，
       当前出牌方鎏金发光，其余暗金）—— 同一平面精确排版，绝不重叠。 */
    _buildCompass() {
      const g = new T.Group();
      const oct = { thetaStart: Math.PI / 8 };   // 八角边面向四家
      const rim = new T.Mesh(
        new T.CylinderGeometry(R_COMPASS + 0.18, R_COMPASS + 0.35, 0.5, 8, 1, false, oct.thetaStart),
        new T.MeshStandardMaterial({ color: COL.compassRim, roughness: 0.3, metalness: 0.7 }));
      rim.position.y = 0.1;
      rim.receiveShadow = true;
      g.add(rim);
      const plate = new T.Mesh(
        new T.CylinderGeometry(R_COMPASS, R_COMPASS, 0.42, 8, 1, false, oct.thetaStart),
        new T.MeshStandardMaterial({ color: COL.compass, roughness: 0.35, metalness: 0.4 }));
      plate.position.y = 0.14;
      plate.receiveShadow = true;
      g.add(plate);
      this._compassCv = document.createElement('canvas');
      this._compassCv.width = this._compassCv.height = 512;
      this._compassTex = new T.CanvasTexture(this._compassCv);
      this._compassTex.encoding = T.sRGBEncoding;
      this._compassTex.anisotropy = 4;
      const top = new T.Mesh(
        new T.PlaneGeometry(R_COMPASS * 2, R_COMPASS * 2),
        new T.MeshBasicMaterial({ map: this._compassTex, transparent: true }));
      top.rotation.x = -Math.PI / 2;
      top.position.y = 0.36;
      g.add(top);
      // 四颗座位指示灯（当前行动家点亮，与座风字高亮呼应）
      this.windBlocks = [];
      const dotGeo = new T.SphereGeometry(0.15, 14, 10);
      for (let i = 0; i < 4; i++) {
        const mat = new T.MeshStandardMaterial({
          color: 0x37507a, emissive: 0x000000, emissiveIntensity: 0,
          roughness: 0.4, metalness: 0.3,
        });
        const dot = new T.Mesh(dotGeo, mat);
        const d = SEAT_DIR[i];
        dot.position.set(d.x * 2.05, 0.44, d.z * 2.05);
        g.add(dot);
        this.windBlocks.push({ mesh: dot, mat });
      }
      this.scene.add(g);
      this.compass = g;
      this._drawCompass();
    }

    _drawCompass() {
      const cv = this._compassCv;
      if (!cv) return;
      const g = cv.getContext('2d');
      const W = 512, C = 256, R = 250;
      g.clearRect(0, 0, W, W);
      // 八角盘面（边面向四家：顶点在 22.5°+k·45°）
      g.beginPath();
      for (let k = 0; k < 8; k++) {
        const a = Math.PI / 8 + k * Math.PI / 4;
        const x = C + Math.sin(a) * R, y = C - Math.cos(a) * R;
        if (k) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.closePath();
      g.fillStyle = 'rgba(7,11,28,0.96)';
      g.fill();
      g.strokeStyle = 'rgba(216,180,108,0.85)';
      g.lineWidth = 5;
      g.stroke();
      // 电子网格 + 同心环（裁剪在八角内）
      g.save();
      g.clip();
      g.strokeStyle = 'rgba(120,160,220,0.14)';
      g.lineWidth = 1;
      for (let i = -R + 26; i < R; i += 26) {
        g.beginPath(); g.moveTo(C + i, C - R); g.lineTo(C + i, C + R); g.stroke();
        g.beginPath(); g.moveTo(C - R, C + i); g.lineTo(C + R, C + i); g.stroke();
      }
      g.strokeStyle = 'rgba(216,180,108,0.4)';
      g.lineWidth = 2.5;
      g.beginPath(); g.arc(C, C, 208, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.arc(C, C, 160, 0, Math.PI * 2); g.stroke();
      g.restore();
      // 中心圆盘：两行文字（局数 / 余牌）
      g.beginPath(); g.arc(C, C, 118, 0, Math.PI * 2);
      g.fillStyle = 'rgba(12,18,44,0.92)';
      g.fill();
      g.strokeStyle = 'rgba(216,180,108,0.55)';
      g.lineWidth = 3;
      g.stroke();
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = '#ffe9b0';
      g.font = '700 52px "STKaiti","KaiTi","Kaiti SC",serif';
      g.fillText(this._compassL1 || '东一局', C, C - 27);
      g.fillStyle = 'rgba(245,239,221,0.75)';
      g.font = '600 33px "STKaiti","KaiTi","Kaiti SC",serif';
      g.fillText(this._compassL2 || '余 83 张', C, C + 35);
      // 四内缘座风字：各自朝向对应座位（canvas 上=北/对家，右=东/右家）
      const winds = this._compassWinds || ['东', '南', '西', '北'];
      const pos = [
        [C, C + 192, Math.PI],        // pid0 南：字顶朝 +Z（canvas 下）→ 转 180°
        [C + 192, C, Math.PI / 2],    // pid1 东：字顶朝 +X（canvas 右）→ 转 +90°
        [C, C - 192, 0],              // pid2 北：字顶朝 -Z（canvas 上）
        [C - 192, C, -Math.PI / 2],   // pid3 西：字顶朝 -X（canvas 左）→ 转 -90°
      ];
      for (let pid = 0; pid < 4; pid++) {
        const [x, y, rot] = pos[pid];
        const active = pid === this._compassTurn;
        g.save();
        g.translate(x, y);
        g.rotate(rot);
        g.font = '700 64px "STKaiti","KaiTi","Kaiti SC",serif';
        if (active) {
          g.shadowColor = 'rgba(255,200,90,0.95)';
          g.shadowBlur = 26;
          g.fillStyle = '#ffe9b0';
        } else {
          g.shadowBlur = 0;
          g.fillStyle = 'rgba(216,180,108,0.42)';
        }
        g.fillText(winds[pid] || '东', 0, 0);
        g.restore();
      }
      this._compassTex.needsUpdate = true;
    }

    _buildGroups() {
      this.groups = [];
      for (let pid = 0; pid < 4; pid++) {
        this.groups.push({
          hand: new T.Group(), river: new T.Group(), meld: new T.Group(),
        });
        this.scene.add(this.groups[pid].hand, this.groups[pid].river, this.groups[pid].meld);
      }
    }

    _buildCursor() {
      const mat = new T.MeshStandardMaterial({
        color: COL.gold, emissive: 0xaa7a20, emissiveIntensity: 0.9,
        roughness: 0.25, metalness: 0.7,
      });
      this.cursor = new T.Mesh(new T.ConeGeometry(0.4, 0.8, 4), mat);
      this.cursor.rotation.x = Math.PI;
      this.cursor.visible = false;
      this.scene.add(this.cursor);
    }

    /* ---------- 布局 ---------- */

    /** 手牌 + 副露联合排版：同一条桌沿基准线，整块沿「自身右手」方向居中；
        手牌占左手侧、副露紧随其后向右手角平铺 —— 手牌每吃碰一次少 3 张，
        总长恒 ≤ 14 张牌长，几何上杜绝副露与手牌/牌河穿模。 */
    _seatLayout(pid) {
      const h = this._handInfo[pid] || { count: 13, fresh: -1 };
      const mw = (this._meldInfo[pid] || { total: 0 }).total;
      const handW = h.count * HAND_PITCH + (h.fresh >= 0 ? DRAW_GAP : 0);
      const total = handW + (mw > 0 ? MELD_GAP + mw : 0);
      return { start: -total / 2, handW, total };
    }

    /** 牌河第 i 张的世界坐标：每行 6 张、行内从该玩家左手到右手、
        换行向靠近其自身（远离罗盘）推进；第 1 行中心距桌心 R_RIVER=4.45 */
    riverSlot(pid, i) {
      const col = i % RIVER_COLS, row = (i / RIVER_COLS) | 0;
      const d = SEAT_DIR[pid], t = TAN[pid];
      const along = (col - (RIVER_COLS - 1) / 2) * RX;
      const out = R_RIVER + row * RZ;
      return new T.Vector3(
        t.x * along + d.x * out,
        TILE_D / 2 + 0.02,
        t.z * along + d.z * out);
    }

    /** 手牌第 i 张立牌坐标（从左到右升序；摸牌在最右并留 DRAW_GAP 间距） */
    handSlot(pid, i, count) {
      const t = TAN[pid], d = SEAT_DIR[pid];
      const L = this._seatLayout(pid);
      const fresh = (this._handInfo[pid] || {}).fresh;
      const along = L.start + TILE_W / 2 + i * HAND_PITCH + (i === fresh ? DRAW_GAP : 0);
      const base = R_HAND + TILE_D / 2;
      return new T.Vector3(
        t.x * along + d.x * base,
        TILE_H / 2 + 0.02,
        t.z * along + d.z * base);
    }

    /* ---------- 同步（由 ui.js 调） ---------- */

    /** 手牌立牌同步：diff 复用 mesh；新牌 180ms 从上方 0.6 落入（摸牌） */
    syncHand(pid, tiles, opts) {
      opts = opts || {};
      const grp = this.groups[pid].hand;
      this._handInfo[pid] = {
        count: tiles.length,
        fresh: (pid === 0 && opts.freshIdx !== undefined) ? opts.freshIdx : -1,
      };
      const standQuat = pid === 0 ? MY_STAND_QUAT : aiStandQuat(pid);
      while (grp.children.length > tiles.length) {
        const m = grp.children.pop();
        killTweensOf(m.uuid);
        grp.remove(m);
      }
      tiles.forEach((tIdx, i) => {
        let mesh = grp.children[i];
        if (!mesh) {
          mesh = makeTile(tIdx, this.mats, this.MJ);
          grp.add(mesh);
          const target = this.handSlot(pid, i, tiles.length);
          if (opts.animate) {
            // 发牌入场：整手牌从上方错峰落下
            mesh.position.set(target.x, target.y + 5, target.z);
            mesh.quaternion.copy(standQuat);
            const ty = target.y;
            tween(340, (e) => { mesh.position.y = ty + 5 * (1 - e); }, {
              delay: i * 30, ease: easeOutCubic, tag: mesh.uuid,
            });
          } else {
            // 摸牌：180ms 从上方 0.6 平滑落入
            mesh.position.set(target.x, target.y + 0.6, target.z);
            mesh.quaternion.copy(standQuat);
            const ty = target.y;
            tween(180, (e) => { mesh.position.y = ty + 0.6 * (1 - e); }, {
              ease: easeOutCubic, tag: mesh.uuid,
            });
          }
          if (pid === 0) mesh.userData.baseY = target.y;
          return;
        }
        // 更新：牌面 / 位置（数量变化时重排）
        if (mesh.userData.tileIndex !== tIdx) {
          mesh.userData.tileIndex = tIdx;
          mesh.userData.body.material[0] = this.mats.face(tIdx);
        }
        const target = this.handSlot(pid, i, tiles.length);
        if (!mesh.position.equals(target)) mesh.position.copy(target);
        if (!mesh.quaternion.equals(standQuat)) mesh.quaternion.copy(standQuat);
        if (pid === 0) {
          mesh.userData.baseY = target.y;
          const m = mesh.userData.body.material[0];
          if (m && m.emissive) {
            if (opts.freshIdx === i) { m.emissive.setHex(0xffc24d); m.emissiveIntensity = 0.42; }
            else if (this._sameTarget === null || tIdx !== this._sameTarget) {
              m.emissive.setHex(0x000000); m.emissiveIntensity = 0;
            }
          }
        }
      });
      if (pid === 0) {
        this.myHandTiles = tiles.slice();
        this.freshIdx = (opts.freshIdx === undefined) ? -1 : opts.freshIdx;
        this._refreshMyHandVisual();
      }
    }

    /** 牌河同步；pendingPid 的最后一张先隐藏，等落桌后 reveal（按座位分槽） */
    syncRivers(discards, cursorPid, opts) {
      opts = opts || {};
      this._pending = this._pending || {};
      for (let pid = 0; pid < 4; pid++) {
        const tiles = discards[pid];
        const grp = this.groups[pid].river;
        const q = FLAT_QUATS[pid];
        const hideLast = opts.pendingPid === pid;
        while (grp.children.length > tiles.length) grp.remove(grp.children.pop());
        tiles.forEach((tIdx, i) => {
          let mesh = grp.children[i];
          const isLast = i === tiles.length - 1;
          const target = this.riverSlot(pid, i);
          if (!mesh) {
            mesh = makeTile(tIdx, this.mats, this.MJ);
            grp.add(mesh);
            mesh.quaternion.copy(q);
            mesh.position.copy(target);
            if (opts.animateNew && isLast && !hideLast) {
              mesh.position.y = target.y + 2;
              tween(180, (e) => { mesh.position.y = target.y + 2 * (1 - e); }, {
                ease: easeOutCubic, tag: mesh.uuid,
              });
            }
          }
          if (mesh.userData.tileIndex !== tIdx) {
            mesh.userData.tileIndex = tIdx;
            mesh.userData.body.material[0] = this.mats.face(tIdx);
          }
          const heldPending = this._pending[pid] && this._pending[pid].mesh === mesh;
          if (hideLast && isLast) {
            const old = this._pending[pid];
            if (old && old.mesh !== mesh) old.mesh.visible = true;   // 同座位连续出牌：旧 pending 立即揭示
            mesh.visible = false;
            this._pending[pid] = { mesh, pid };
          } else if (!heldPending) {
            mesh.visible = true;
          }
          if (!mesh.position.equals(target)) mesh.position.copy(target);
          this._setEmissive(mesh, this._sameTarget !== null && tIdx === this._sameTarget);
        });
        // 光标：最新弃牌上方
        if (pid === cursorPid && tiles.length) {
          const top = this.riverSlot(pid, tiles.length - 1);
          this.cursor.visible = true;
          this.cursor.position.set(top.x, TILE_D + 1.0, top.z);
          this._cursorTile = top;
        }
      }
      if (cursorPid < 0 || !discards[cursorPid] || !discards[cursorPid].length) {
        this.cursor.visible = false;
      }
    }

    /** 副露同步：与手牌同一条桌沿基准线（手牌左、副露右）；平躺只绕 Y 旋转，
        被鸣牌额外转 90° 并偏移对齐；暗杠两端翻面（牌背朝上） */
    syncMelds(pid, melds) {
      const grp = this.groups[pid].meld;
      const q = FLAT_QUATS[pid];
      while (grp.children.length) {
        const m = grp.children.pop();
        killTweensOf(m.uuid);
        grp.remove(m);
      }
      const t = TAN[pid], d = SEAT_DIR[pid];
      const base = R_HAND + TILE_D / 2;
      const total = melds.reduce((s, m) => {
        const cl = (m.from >= 0 && m.tiles.indexOf(m.tile) >= 0) ? 0.25 : 0;
        return s + m.tiles.length * HAND_PITCH + cl;
      }, 0) + Math.max(0, melds.length - 1) * GROUP_GAP;
      this._meldInfo[pid] = { total };
      grp.userData.groupCount = melds.length;
      // 吃/碰/杠聚拢动画（playClaim 标记 → 本次重建的牌错峰落入）
      const pulse = this._pulsePid === pid;
      if (pulse) this._pulsePid = -1;
      const L = this._seatLayout(pid);
      let acc = L.start + L.handW + (melds.length ? MELD_GAP : 0);
      let claimedCount = 0, idx = 0;
      melds.forEach((m) => {
        // 被鸣牌下标：吃牌的被鸣牌通常在中间（如 2p[3p]4p），碰/杠则在第 0 张
        const claimedIdx = m.from >= 0 ? m.tiles.indexOf(m.tile) : -1;
        const isConcealedKong = m.kind === 'concealed_kong' ||
          (m.tiles.length === 4 && m.from < 0 && !m.added);
        let extra = 0;
        m.tiles.forEach((tIdx, k) => {
          const claimed = k === claimedIdx;
          const faceDown = isConcealedKong && (k === 0 || k === 3);
          const mesh = makeTile(tIdx, this.mats, this.MJ);
          mesh.quaternion.copy(q);
          if (claimed) { mesh.rotateY(Math.PI / 2); claimedCount++; }  // 横置 90°（顶面仍朝上）
          if (faceDown) mesh.rotateX(Math.PI);                         // 暗杠两端牌背朝上
          const along = acc + TILE_W / 2 + extra + k * HAND_PITCH
            + (claimed ? (TILE_H - TILE_W) / 2 * 0.7 : 0);
          const ty = TILE_D / 2 + 0.02;
          mesh.position.set(t.x * along + d.x * base, ty, t.z * along + d.z * base);
          if (pulse) {
            mesh.position.y = ty + 0.9;
            tween(220, (e) => { mesh.position.y = ty + 0.9 * (1 - e); }, {
              delay: idx * 35, ease: easeOutCubic, tag: mesh.uuid,
            });
          }
          grp.add(mesh);
          if (claimed) extra += 0.25;
          idx++;
        });
        acc += m.tiles.length * HAND_PITCH
          + (claimedIdx >= 0 ? 0.25 : 0) + GROUP_GAP;
      });
      grp.userData.claimedCount = claimedCount;
    }

    /* ---------- 视觉状态 ---------- */
    _setEmissive(mesh, on) {
      const body = mesh.userData.body;
      const m = body.material[0];
      if (!m || !m.emissive) return;
      m.emissive = m.emissive || new T.Color(0);
      if (on) { m.emissive.setHex(0x35c98e); m.emissiveIntensity = 0.55; }
      else { m.emissive.setHex(0x000000); m.emissiveIntensity = 0; }
    }

    /** 同名牌高亮（牌河 + 副露） */
    highlightSame(tileIdx) {
      this._sameTarget = (tileIdx === null || tileIdx === undefined) ? null : tileIdx;
      for (let pid = 0; pid < 4; pid++) {
        for (const mesh of this.groups[pid].river.children) {
          this._setEmissive(mesh, this._sameTarget !== null && mesh.userData.tileIndex === this._sameTarget);
        }
        for (const mesh of this.groups[pid].meld.children) {
          this._setEmissive(mesh, this._sameTarget !== null && mesh.userData.tileIndex === this._sameTarget);
        }
      }
    }

    /** 我方手牌选中/悬停升起与金边光晕 */
    _refreshMyHandVisual() {
      const grp = this.groups[0].hand;
      grp.children.forEach((mesh, i) => {
        const lift = (i === this.selectedIdx) ? 0.35 : (i === this.hoverIdx ? 0.18 : 0);
        const base = mesh.userData.baseY !== undefined ? mesh.userData.baseY : TILE_H / 2 + 0.02;
        if (!tweens.some((t) => t.tag === mesh.uuid && !t.dead)) {
          const y0 = mesh.position.y;
          tween(120, (k) => { mesh.position.y = y0 + (base + lift - y0) * k; }, { tag: mesh.uuid });
        }
        const body = mesh.userData.body;
        const m = body.material[0];
        if (m && m.emissive) {
          if (i === this.selectedIdx) { m.emissive.setHex(0xffc24d); m.emissiveIntensity = 0.5; }
          else if (i === this.hoverIdx) { m.emissive.setHex(0xffc24d); m.emissiveIntensity = 0.22; }
          else if (i === this.freshIdx) { m.emissive.setHex(0xffc24d); m.emissiveIntensity = 0.42; }
          else if (this._sameTarget === null || mesh.userData.tileIndex !== this._sameTarget) {
            m.emissive.setHex(0x000000); m.emissiveIntensity = 0;
          }
        }
      });
    }

    setSelected(idx) {
      this.selectedIdx = idx;
      this._refreshMyHandVisual();
    }
    setHover(idx) {
      if (this.hoverIdx === idx) return;
      this.hoverIdx = idx;
      this._refreshMyHandVisual();
      if (this.onHoverTile) {
        this.onHoverTile(idx >= 0 ? idx : null, idx >= 0 ? this.myHandTiles[idx] : null);
      }
    }

    setTurn(pid) {
      this._compassTurn = pid;
      this._drawCompass();
      this.windBlocks.forEach((b, i) => {
        const active = i === pid;
        b.mat.emissive.setHex(active ? 0xffb84d : 0x000000);
        b.mat.emissiveIntensity = active ? 1.1 : 0;
        b.mat.color.setHex(active ? 0xffd98c : 0x37507a);
      });
    }

    /** 中央罗盘文字（由 ui.js renderTopbar 同步）：局数 / 余牌 / 四家座风 */
    setCompassInfo(line1, line2, winds) {
      this._compassL1 = line1 || '';
      this._compassL2 = line2 || '';
      if (winds && winds.length === 4) this._compassWinds = winds.slice();
      this._drawCompass();
    }

    /* ---------- 纯麻将块补间动画（无手部模型） ---------- */

    /** 出牌（220ms）：打出的牌从手牌区沿轻抛物线飞入牌河目标格位，
        落桌瞬间金色波纹消散 + 镜头轻震；onLand 揭示牌河真牌 */
    playDiscard(pid, discards, cursorPid) {
      const i = discards[pid].length - 1;
      if (i < 0) return;
      const tileIdx = discards[pid][i];
      const toPos = this.riverSlot(pid, i).clone();
      const t = TAN[pid], d = SEAT_DIR[pid];
      // 出手点：手牌区靠右手端、立牌高度
      const fromPos = new T.Vector3(
        t.x * 3.2 + d.x * (R_HAND - 0.4),
        TILE_H * 0.8,
        t.z * 3.2 + d.z * (R_HAND - 0.4));
      const carried = makeTile(tileIdx, this.mats, this.MJ);
      carried.position.copy(fromPos);
      const q0 = pid === 0 ? MY_STAND_QUAT : aiStandQuat(pid);
      const q1 = FLAT_QUATS[pid];
      carried.quaternion.copy(q0);
      this.scene.add(carried);
      const apex = fromPos.clone().lerp(toPos, 0.5);
      apex.y += 2.0;
      tween(220, (e, k) => {
        const a = fromPos.clone().lerp(apex, k);
        const b = apex.clone().lerp(toPos, k);
        carried.position.copy(a.lerp(b, k));
        carried.quaternion.slerpQuaternions(q0, q1, clamp(k * 1.4, 0, 1));
      }, {
        ease: easeInOutQuad,
        onDone: () => {
          this.scene.remove(carried);
          const pr = this._pending && this._pending[pid];
          if (pr) { pr.mesh.visible = true; delete this._pending[pid]; }
          this._shockwave(toPos);
          this._shake(0.35);
        },
      });
    }

    /** 摸牌：动画由 syncHand 的新牌落入补间呈现（180ms 上方 0.6 落入） */
    playDraw(pid) { /* no-op：syncHand 已覆盖 */ }

    /** 吃/碰/杠（220ms）：副露牌在副露区平滑聚拢就位（syncMelds 播放错峰落入） */
    playClaim(pid) {
      this._pulsePid = pid;
      this._shake(0.3);
    }

    /** 落点金色水波纹 */
    _shockwave(pos) {
      const ring = new T.Mesh(
        new T.RingGeometry(0.3, 0.62, 40),
        new T.MeshBasicMaterial({
          color: 0xffd98c, transparent: true, opacity: 0.95,
          side: T.DoubleSide, blending: T.AdditiveBlending, depthWrite: false,
        }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(pos.x, 0.1, pos.z);
      this.scene.add(ring);
      tween(460, (k) => {
        ring.scale.setScalar(1 + k * 3.6);
        ring.material.opacity = 0.95 * (1 - k);
      }, { ease: easeOutCubic, onDone: () => this.scene.remove(ring) });
    }

    /** 镜头轻震 */
    _shake(power) {
      this.camShake = Math.min(1.2, this.camShake + power);
    }

    /* ---------- 指针拾取 ---------- */
    _canvasLocal(e) {
      const cv = this.renderer.domElement;
      const r = cv.getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY;
      // 判定 #app 旋转角（竖屏时 90°）：canvas-local = R⁻¹ · (screen - center)
      let deg = 0;
      const app = document.getElementById('app');
      if (app) {
        const tr = getComputedStyle(app).transform;
        if (tr && tr !== 'none') {
          const m = tr.match(/matrix\(([^)]+)\)/);
          if (m) {
            const a = parseFloat(m[1].split(',')[0]);
            const b = parseFloat(m[1].split(',')[1]);
            deg = Math.round(Math.atan2(b, a) * 180 / Math.PI);
          }
        }
      }
      const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
      const dx = sx - cx, dy = sy - cy;
      let lx, ly;
      const Lw = r.width, Lh = r.height;   // 旋转 90° 时屏幕盒宽高互换 = 逻辑宽高
      if (deg === 90) { lx = Lw / 2 + dy; ly = Lh / 2 - dx; }
      else if (deg === -90 || deg === 270) { lx = Lw / 2 - dy; ly = Lh / 2 + dx; }
      else if (deg === 180) { lx = Lw / 2 - dx; ly = Lh / 2 - dy; }
      else { lx = Lw / 2 + dx; ly = Lh / 2 + dy; }
      return { x: lx, y: ly, w: Lw, h: Lh };
    }

    _pick(e) {
      const p = this._canvasLocal(e);
      const cv = this.renderer.domElement;
      this.ndc.set((p.x / p.w) * 2 - 1, -(p.y / p.h) * 2 + 1);
      this.ray.setFromCamera(this.ndc, this.camera);
      const grp = this.groups[0].hand;
      const hits = this.ray.intersectObjects(grp.children, true);
      if (!hits.length) return -1;
      let o = hits[0].object;
      while (o && o.parent !== grp) o = o.parent;
      return grp.children.indexOf(o);
    }

    _bindPointer() {
      const cv = this.renderer.domElement;
      cv.style.touchAction = 'none';
      cv.addEventListener('pointermove', (e) => {
        if (this.selectedIdx >= 0) return;
        if (!this.opts.canPick || !this.opts.canPick()) { this.setHover(-1); return; }
        const i = this._pick(e);
        this.setHover(i);
      }, { passive: true });
      cv.addEventListener('pointerleave', () => this.setHover(-1), { passive: true });
      cv.addEventListener('pointerdown', (e) => {
        if (!this.opts.canPick || !this.opts.canPick()) return;
        const i = this._pick(e);
        if (i < 0) return;
        if (this.onPickTile) this.onPickTile(i, this.myHandTiles[i]);
      });
    }

    /* ---------- 相机 ---------- */
    resize() {
      const w = this.container.offsetWidth || 960;
      const h = this.container.offsetHeight || 540;
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this._fitCamera();
      this.renderer.render(this.scene, this.camera);
    }

    /* 雀魂式取景：fov40，基准机位 (0,22.5,17.5) → lookAt(0,0,1.4)；
       按宽高比自动微调距离（沿视线方向缩放机位向量），保证窄屏/宽屏下
       四家手牌 + 副露块四周均有充足留白。 */
    _fitCamera() {
      const cam = this.camera;
      cam.fov = 40;
      cam.updateProjectionMatrix();
      const look = new T.Vector3(0, 0, 1.4);
      const off = new T.Vector3(0, 22.5, 16.1);       // basePos - lookAt
      const v = new T.Vector3();
      /* 内容约束：四家「手牌 + 副露」联合块角点（含立牌顶）全部在画面内 */
      const SPAN = (14 / 2) * HAND_PITCH + DRAW_GAP + TILE_W;
      const pts = [];
      for (let pid = 0; pid < 4; pid++) {
        const t = TAN[pid], d = SEAT_DIR[pid], base = R_HAND + TILE_D / 2;
        for (const s of [-SPAN, SPAN]) {
          pts.push(
            new T.Vector3(t.x * s + d.x * base, 0, t.z * s + d.z * base),
            new T.Vector3(t.x * s + d.x * base, TILE_H + 0.55, t.z * s + d.z * base));
        }
      }
      const fits = (k) => {
        cam.position.copy(look).addScaledVector(off, k);
        cam.lookAt(look);
        cam.updateMatrixWorld();
        for (const p of pts) {
          v.copy(p).project(cam);
          if (v.x < -0.94 || v.x > 0.94 || v.y < -0.94 || v.y > 0.94) return false;
        }
        return true;
      };
      let k = 0.9;
      if (!fits(k)) {
        let lo = 0.9, hi = 2.4;
        for (let i = 0; i < 18; i++) {
          const mid = (lo + hi) / 2;
          if (fits(mid)) hi = mid; else lo = mid;
        }
        k = hi;
      }
      this._camBase = { pos: look.clone().addScaledVector(off, k), look };
      this.camK = k;
      cam.position.copy(this._camBase.pos);
      cam.lookAt(look);
    }

    _tick(now) {
      // 光标浮动
      if (this.cursor.visible) {
        this.cursor.position.y = TILE_D + 1.0 + Math.sin(now / 380) * 0.22;
        this.cursor.rotation.y = now / 700;
      }
      // 镜头震动衰减
      if (this.camShake > 0.001) {
        this.camShake *= 0.86;
        const s = this.camShake;
        const base = this._camBase;
        this.camera.position.copy(base.pos);
        this.camera.position.x += (Math.random() - 0.5) * s * 0.5;
        this.camera.position.y += (Math.random() - 0.5) * s * 0.35;
        this.camera.lookAt(base.look);
      }
    }

    /** 发牌前重置：清空全部牌组与状态，随后的 sync 将带入场动画重建 */
    resetForDeal() {
      for (let pid = 0; pid < 4; pid++) {
        const g = this.groups[pid];
        [g.hand, g.river, g.meld].forEach((grp) => {
          while (grp.children.length) {
            const m = grp.children.pop();
            killTweensOf(m.uuid);
          }
        });
      }
      this._pending = {};
      this._sameTarget = null;
      this._handInfo = {};
      this._meldInfo = {};
      this._pulsePid = -1;
      this.cursor.visible = false;
      this.hoverIdx = -1;
      this.selectedIdx = -1;
      this.myHandTiles = [];
    }

    /** 调试接口（e2e / 截图测试用）：不改 UI 状态，只读 + 受控点击 */
    debug() {
      const self = this;
      return {
        is3D: true,
        canvasPresent() { return !!document.getElementById('table-3d'); },
        tileMeshCount() {
          let n = 0;
          for (let pid = 0; pid < 4; pid++) {
            n += self.groups[pid].hand.children.length +
                 self.groups[pid].river.children.length +
                 self.groups[pid].meld.children.length;
          }
          return n;
        },
        handCount(pid) { return self.groups[pid].hand.children.length; },
        riverCount(pid) { return self.groups[pid].river.children.filter((m) => m.visible).length; },
        meldGroups(pid) { return self.groups[pid].meld.userData.groupCount || 0; },
        meldClaimed(pid) { return self.groups[pid].meld.userData.claimedCount || 0; },
        /** 出牌飞行中尚未落桌的 pending 数（测试用它等待动画收敛） */
        pendingCount() { return self._pending ? Object.keys(self._pending).length : 0; },
        /** 触发我方第 i 张手牌的点击（与真实射线点击同一路径：onPickTile 回调） */
        clickHandTile(i) {
          if (i < 0 || i >= self.myHandTiles.length) return false;
          if (self.onPickTile) { self.onPickTile(i, self.myHandTiles[i]); return true; }
          return false;
        },
        hoverHandTile(i) {
          if (i < 0 || i >= self.myHandTiles.length) { self.setHover(-1); return false; }
          self.setHover(i); return true;
        },
        unhover() { self.setHover(-1); },
      };
    }

    /* ---------- 销毁 ---------- */
    dispose() {
      this.destroyed = true;
      global.removeEventListener('resize', this._onResize);
      tweens.length = 0;
      this.renderer.dispose();
      if (this.renderer.domElement.parentNode) {
        this.renderer.domElement.parentNode.removeChild(this.renderer.domElement);
      }
      faceTexCache.clear();
    }
  }

  /* ================= 对外 API ================= */
  const API = {
    isSupported() {
      return !!(global.THREE && webglAvailable());
    },
    mount(container, MJ, opts) {
      if (!API.isSupported()) return null;
      try {
        return new Table3D(container, MJ, opts);
      } catch (e) {
        try { console.warn('table3d 初始化失败，回退平面渲染:', e && e.message); } catch (_) {}
        return null;
      }
    },
  };

  global.MJTable3D = API;
})(typeof window !== 'undefined' ? window : globalThis);
