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
  const GAP = 0.08;                                    // 牌间微缝（按真实脚印计）
  const TILE_R = 0.13, BEVEL = 0.04;                   // 圆角与倒角
  /* 倒角会把手牌轮廓向外扩 BEVEL/边 —— 真实占地脚印比名义尺寸大 0.08：
     实测牌河牌世界 AABB = 1.23 × 1.64。所有步进常量必须按「脚印 + GAP」计，
     否则全场相邻牌互相穿透（历史上 GAP=0.06 直接造成 0.02 重叠） */
  const FOOT_W = TILE_W + BEVEL * 2;                   // 1.23 —— 真实脚印宽
  const FOOT_H = TILE_H + BEVEL * 2;                   // 1.64 —— 真实脚印长

  const RIVER_COLS = 6, RIVER_ROWS = 3;
  const RX = FOOT_W + GAP;                             // 1.31 —— 行内步进
  const RZ = FOOT_H + GAP;                             // 1.72 —— 换行步进
  const R_COMPASS = 2.5;                               // 中央罗盘外径
  const R_RIVER = 4.8;                                 // 牌河第 1 行中心距桌心
                                                       // 需 ≥ 2.5·RX + FOOT_H/2 + FOOT_W/2
                                                       // = 4.71（对角分离轴：与相邻玩家
                                                       //   牌河的角部错开），取 4.8；
                                                       // 第 3 行外缘 9.06 < 副露内缘 9.19 ✓
  const R_HAND = 9.6;                                  // 手牌/副露桌沿基准线
  const HAND_PITCH = FOOT_W + GAP;                     // 手牌步进
  const DRAW_GAP = 0.35 * TILE_W;                      // 摸牌自动留出的间距
  const MELD_GAP = 0.6;                                // 手牌段与副露段间距
  const GROUP_GAP = 0.3;                               // 副露组间距

  const COL = {
    ivory: 0xf5eedc,
  };

  /* ================= 主题皮肤（顶栏「🎨」切换，localStorage 持久化） =================
     竹韵翡翠（默认推荐）/ 深海鎏金 / 紫檀玄金 —— 绒毡、木框、鎏金、牌背整套联动 */
  const THEMES = {
    jade: {
      name: '竹韵翡翠',
      feltIn: '#0c3b2e', feltOut: '#051d16',
      wood: 0x4a2c1a, woodHi: 0x6b4226,
      gold: 0xe5c168, shell: 0x9b2d1f, floor: 0x07090f,
    },
    ocean: {
      name: '深海鎏金',
      feltIn: '#0c1f3d', feltOut: '#050d1d',
      wood: 0x211c16, woodHi: 0x3a2d20,
      gold: 0xd8b46c, shell: 0xb03424, floor: 0x060811,
    },
    sandal: {
      name: '紫檀玄金',
      feltIn: '#1c1817', feltOut: '#0c0a09',
      wood: 0x5d2417, woodHi: 0x7c3520,
      gold: 0xe0b45c, shell: 0x1f7a4d, floor: 0x0a0806,
    },
  };
  const THEME_ORDER = ['jade', 'ocean', 'sandal'];
  let activeTheme = 'jade';
  try {
    const saved = global.localStorage && global.localStorage.getItem('mj-theme');
    if (saved && THEMES[saved]) activeTheme = saved;
  } catch (e) { /* ignore */ }
  function theme() { return THEMES[activeTheme]; }

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
    const depth = TILE_D - BEVEL * 2;
    const geo = extrudeRounded(TILE_W, TILE_H, TILE_R, depth, BEVEL);
    // 挤出体 Z 轴居中（z ∈ [-depth/2, +depth/2]）：平躺 R_x(-90°) 后厚度
    // 对称跨在原点两侧，position.y = TILE_D/2 即正好落在桌面，且暗杠
    // rotateY(π) 翻面不会产生高度偏移
    geo.translate(0, 0, -depth / 2);
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

  /* ---- 程序化织锦绒毡贴图（1024²）：径向聚光渐变 + 织物微噪 + 国风鎏金暗花 ----
     桌面内腔 22.8×22.8 世界单位 → 1024px，px/单位 = 44.9：
     手牌内侧 R=8.2 → 368px 鎏金回纹双圈内框（四角云雷拐角）；
     罗盘外围 R=3.4 → 153px 暗金莲瓣底纹圈。 */
  function makeFeltTextures() {
    const th = theme();
    const S = 1024, C = S / 2, PPU = S / 22.8;
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const g = cv.getContext('2d');
    /* 径向聚光：中心暖润、四周深邃 */
    const grad = g.createRadialGradient(C, C, S * 0.04, C, C, S * 0.6);
    grad.addColorStop(0, th.feltIn);
    grad.addColorStop(1, th.feltOut);
    g.fillStyle = grad;
    g.fillRect(0, 0, S, S);
    /* 织物微噪点（细密斜纹 + 随机纤维） */
    g.globalAlpha = 0.05;
    for (let i = -S; i < S * 2; i += 5) {
      g.strokeStyle = '#ffffff';
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i + S, S); g.stroke();
    }
    for (let i = 0; i < 2600; i++) {
      g.fillStyle = Math.random() > 0.5 ? '#ffffff' : '#000000';
      g.fillRect(Math.random() * S, Math.random() * S, 1.4, 1.4);
    }
    g.globalAlpha = 1;
    /* 国风鎏金暗花 */
    const goldRing = (r, w, alpha) => {
      g.strokeStyle = 'rgba(229, 193, 104, ' + alpha + ')';
      g.lineWidth = w;
      g.beginPath(); g.arc(C, C, r, 0, Math.PI * 2); g.stroke();
    };
    goldRing(8.2 * PPU, 3, 0.4);
    goldRing(8.2 * PPU - 12, 1.6, 0.28);
    goldRing(3.4 * PPU, 2.2, 0.3);
    goldRing(3.4 * PPU + 10, 1.2, 0.2);
    /* 回纹内框四角：云雷纹拐角（简化三层回字） */
    const meander = (x, y, sx, sy) => {
      g.strokeStyle = 'rgba(229, 193, 104, 0.34)';
      g.lineWidth = 2;
      const u = 9;
      g.beginPath();
      g.moveTo(x + sx * 0, y + sy * 0);
      g.lineTo(x + sx * u * 3, y + sy * 0);
      g.lineTo(x + sx * u * 3, y + sy * u * 2);
      g.lineTo(x + sx * u, y + sy * u * 2);
      g.lineTo(x + sx * u, y + sy * u);
      g.lineTo(x + sx * u * 2, y + sy * u);
      g.stroke();
    };
    const R8 = 8.2 * PPU;
    meander(C - R8, C - R8, 1, 1);
    meander(C + R8, C - R8, -1, 1);
    meander(C - R8, C + R8, 1, -1);
    meander(C + R8, C + R8, -1, -1);
    /* 罗盘外围莲瓣底纹（16 瓣小弧） */
    const R3 = 3.4 * PPU;
    g.strokeStyle = 'rgba(229, 193, 104, 0.26)';
    g.lineWidth = 2;
    for (let k = 0; k < 16; k++) {
      const a = (k / 16) * Math.PI * 2;
      g.beginPath();
      g.arc(C + Math.cos(a) * (R3 - 6), C + Math.sin(a) * (R3 - 6), 9, a + Math.PI * 0.4, a + Math.PI * 1.6);
      g.stroke();
    }
    /* bump 图：同一噪点布局的灰度图（bumpScale 0.015 绒布纤维感） */
    const bv = document.createElement('canvas');
    bv.width = bv.height = 256;
    const bg = bv.getContext('2d');
    bg.fillStyle = '#808080';
    bg.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 24000; i++) {
      const v = 90 + Math.floor(Math.random() * 90);
      bg.fillStyle = 'rgb(' + v + ',' + v + ',' + v + ')';
      bg.fillRect(Math.random() * 256, Math.random() * 256, 1.2, 1.2);
    }
    const map = new T.CanvasTexture(cv);
    map.encoding = T.sRGBEncoding;
    map.anisotropy = 8;
    const bump = new T.CanvasTexture(bv);
    bump.wrapS = bump.wrapT = T.RepeatWrapping;
    bump.repeat.set(6, 6);
    return { map, bump };
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

      /* ---- 材质库（牌背壳色随主题联动） ---- */
      const sideIvory = new T.MeshStandardMaterial({ color: COL.ivory, roughness: 0.38, metalness: 0.03 });
      const sideShell = new T.MeshStandardMaterial({ color: theme().shell, roughness: 0.3, metalness: 0.06 });
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
      const th = theme();
      /* 「紫檀鎏金」立体家具感：桌面内腔 22.8×22.8（R_IN=11.4，环绕四家
         手牌外沿），四周紫檀斜切实木桌框 + 鎏金压条 + 四角黄铜包角，
         框外深邃雅室地面 —— 整桌轮廓尽收镜头 */
      const R_IN = 11.4, BW = 1.45, BH = 0.55;
      /* 织锦绒毡桌面（程序化纹理 + bump） */
      const tex = makeFeltTextures();
      const feltMat = new T.MeshStandardMaterial({
        map: tex.map, bumpMap: tex.bump, bumpScale: 0.015,
        roughness: 0.92, metalness: 0,
      });
      const felt = new T.Mesh(new T.PlaneGeometry(R_IN * 2, R_IN * 2), feltMat);
      felt.rotation.x = -Math.PI / 2;
      felt.position.y = 0.005;
      felt.receiveShadow = true;
      this.scene.add(felt);
      this._feltMat = feltMat;
      /* 桌面基座墩（绒毡下的厚台面，边缘被桌框压住）。
         注意：ExtrudeGeometry 带倒角总厚 = depth + 2*bevel = 1.1，
         几何 z 跨 [-bevel, depth+bevel] = [-0.2, 0.9]，R_x(-90°) 后 y 跨同值 ——
         position.y 必须取 -(depth+bevel) = -0.9 才能让顶面正好落在 y=0，
         否则顶面抬到 0.48 会把整张绒毡平面（y=0.005）罩进实体内部。 */
      const baseGeo = extrudeRounded(R_IN * 2 + 0.6, R_IN * 2 + 0.6, 1.2, 0.7, 0.2);
      baseGeo.rotateX(-Math.PI / 2);
      this._baseMat = new T.MeshStandardMaterial({
        color: parseInt(th.feltOut.slice(1), 16),
        roughness: 0.9, metalness: 0,
      });
      const base = new T.Mesh(baseGeo, this._baseMat);
      base.position.y = -0.9;
      this.scene.add(base);
      /* 紫檀实木桌框（四条 + 顶面高光条） */
      const woodMat = new T.MeshStandardMaterial({ color: th.wood, roughness: 0.25, metalness: 0.15 });
      const woodHiMat = new T.MeshStandardMaterial({ color: th.woodHi, roughness: 0.2, metalness: 0.2 });
      const goldMat = new T.MeshStandardMaterial({ color: th.gold, roughness: 0.2, metalness: 0.85 });
      this._woodMat = woodMat; this._woodHiMat = woodHiMat; this._goldMat = goldMat;
      const L = R_IN + BW;                     // 框中线距桌心
      const mk = (w, dpt, x, z) => {
        const m = new T.Mesh(new T.BoxGeometry(w, BH, dpt), woodMat);
        m.position.set(x, BH / 2 - 0.35, z);
        m.castShadow = true; m.receiveShadow = true;
        this.scene.add(m);
        const cap = new T.Mesh(new T.BoxGeometry(w * 0.96, 0.1, dpt * 0.96), woodHiMat);
        cap.position.set(x, BH - 0.33, z);
        this.scene.add(cap);
        return m;
      };
      mk(R_IN * 2 + BW * 2, BW, 0, -(L));      // 北
      mk(R_IN * 2 + BW * 2, BW, 0, L);         // 南
      mk(BW, R_IN * 2, -L, 0);                 // 西
      mk(BW, R_IN * 2, L, 0);                  // 东
      /* 鎏金压条：贴桌框内缘一圈 */
      const trim = (w, dpt, x, z) => {
        const m = new T.Mesh(new T.BoxGeometry(w, 0.09, dpt), goldMat);
        m.position.set(x, BH - 0.36, z);
        this.scene.add(m);
      };
      trim(R_IN * 2 + 0.12, 0.1, 0, -(R_IN + 0.05));
      trim(R_IN * 2 + 0.12, 0.1, 0, R_IN + 0.05);
      trim(0.1, R_IN * 2 + 0.12, -(R_IN + 0.05), 0);
      trim(0.1, R_IN * 2 + 0.12, R_IN + 0.05, 0);
      /* 四角立体雕花黄铜包角 */
      const guardGeo = new T.BoxGeometry(BW + 0.25, BH + 0.18, BW + 0.25);
      [[-L, -L], [L, -L], [-L, L], [L, L]].forEach(([x, z]) => {
        const gm = new T.Mesh(guardGeo, goldMat);
        gm.position.set(x, (BH + 0.18) / 2 - 0.35, z);
        gm.castShadow = true;
        this.scene.add(gm);
        const stud = new T.Mesh(new T.SphereGeometry(0.16, 12, 10), goldMat);
        stud.position.set(x, BH + 0.02, z);
        this.scene.add(stud);
      });
      /* 框外雅室地面（深邃暗色，雾色联动主题） */
      const floorMat = new T.MeshStandardMaterial({ color: th.floor, roughness: 0.98, metalness: 0 });
      const floor = new T.Mesh(new T.PlaneGeometry(240, 240), floorMat);
      floor.rotation.x = -Math.PI / 2;
      floor.position.y = -1.15;
      this.scene.add(floor);
      this._floorMat = floorMat;
      if (this.scene.fog) this.scene.fog.color.setHex(th.floor);
    }

    /* ---- 中央八角罗盘：整体绘制在 512×512 CanvasTexture 上 ----
       中心圆盘两行（局数 / 余牌）+ 四内缘扇区座风字（各自朝向对应座位，
       当前出牌方鎏金发光，其余暗金）—— 同一平面精确排版，绝不重叠。 */
    _buildCompass() {
      const th = theme();
      const g = new T.Group();
      const oct = { thetaStart: Math.PI / 8 };   // 八角边面向四家
      const rim = new T.Mesh(
        new T.CylinderGeometry(R_COMPASS + 0.18, R_COMPASS + 0.35, 0.5, 8, 1, false, oct.thetaStart),
        new T.MeshStandardMaterial({ color: th.gold, roughness: 0.22, metalness: 0.8 }));
      rim.position.y = 0.1;
      rim.receiveShadow = true;
      g.add(rim);
      const plate = new T.Mesh(
        new T.CylinderGeometry(R_COMPASS, R_COMPASS, 0.42, 8, 1, false, oct.thetaStart),
        new T.MeshStandardMaterial({ color: 0x0a0d1c, roughness: 0.18, metalness: 0.55 }));
      plate.position.y = 0.14;
      plate.receiveShadow = true;
      g.add(plate);
      this._compassCv = document.createElement('canvas');
      this._compassCv.width = this._compassCv.height = 1024;
      this._compassTex = new T.CanvasTexture(this._compassCv);
      this._compassTex.encoding = T.sRGBEncoding;
      this._compassTex.anisotropy = 8;
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
      const th = theme();
      const g = cv.getContext('2d');
      const W = 1024, C = 512, R = 500;
      const gold = (a) => {
        const c = new T.Color(th.gold);
        return 'rgba(' + Math.round(c.r * 255) + ',' + Math.round(c.g * 255) + ',' + Math.round(c.b * 255) + ',' + a + ')';
      };
      g.clearRect(0, 0, W, W);
      // 八角盘面（边面向四家：顶点在 22.5°+k·45°）
      g.beginPath();
      for (let k = 0; k < 8; k++) {
        const a = Math.PI / 8 + k * Math.PI / 4;
        const x = C + Math.sin(a) * R, y = C - Math.cos(a) * R;
        if (k) g.lineTo(x, y); else g.moveTo(x, y);
      }
      g.closePath();
      g.fillStyle = 'rgba(6,9,24,0.97)';
      g.fill();
      g.strokeStyle = gold(0.9);
      g.lineWidth = 9;
      g.stroke();
      // 裁剪在八角内：金属拉丝底纹（同心细弧）+ 电子网格
      g.save();
      g.clip();
      g.strokeStyle = 'rgba(190,205,235,0.05)';
      g.lineWidth = 1.4;
      for (let r = 40; r < R; r += 11) {
        g.beginPath(); g.arc(C, C, r, 0, Math.PI * 2); g.stroke();
      }
      g.strokeStyle = 'rgba(120,160,220,0.12)';
      g.lineWidth = 1.6;
      for (let i = -R + 52; i < R; i += 52) {
        g.beginPath(); g.moveTo(C + i, C - R); g.lineTo(C + i, C + R); g.stroke();
        g.beginPath(); g.moveTo(C - R, C + i); g.lineTo(C + R, C + i); g.stroke();
      }
      g.strokeStyle = gold(0.4);
      g.lineWidth = 5;
      g.beginPath(); g.arc(C, C, 416, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.arc(C, C, 320, 0, Math.PI * 2); g.stroke();
      // 行动方扇区整格泛金光渐变（45° 扇区，环带 320..470）
      const act = this._compassTurn;
      if (act >= 0 && act < 4) {
        const center = [Math.PI, Math.PI / 2, 0, -Math.PI / 2][act];  // canvas 角
        const a0 = center - Math.PI / 8, a1 = center + Math.PI / 8;
        const grad = g.createRadialGradient(C, C, 300, C, C, 480);
        grad.addColorStop(0, 'rgba(255,205,100,0)');
        grad.addColorStop(0.75, 'rgba(255,205,100,0.20)');
        grad.addColorStop(1, 'rgba(255,205,100,0)');
        g.fillStyle = grad;
        g.beginPath();
        g.arc(C, C, 480, a0 - Math.PI / 2, a1 - Math.PI / 2);
        g.arc(C, C, 300, a1 - Math.PI / 2, a0 - Math.PI / 2, true);
        g.closePath();
        g.fill();
      }
      g.restore();
      // 中心圆盘：两行文字（局数 / 余牌）
      g.beginPath(); g.arc(C, C, 236, 0, Math.PI * 2);
      g.fillStyle = 'rgba(10,14,36,0.94)';
      g.fill();
      g.strokeStyle = gold(0.6);
      g.lineWidth = 6;
      g.stroke();
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = '#ffe9b0';
      g.font = '700 104px "STKaiti","KaiTi","Kaiti SC",serif';
      g.fillText(this._compassL1 || '东一局', C, C - 54);
      g.fillStyle = 'rgba(245,239,221,0.75)';
      g.font = '600 66px "STKaiti","KaiTi","Kaiti SC",serif';
      g.fillText(this._compassL2 || '余 83 张', C, C + 70);
      // 四内缘座风字：各自朝向对应座位（canvas 上=北/对家，右=东/右家）
      const winds = this._compassWinds || ['东', '南', '西', '北'];
      const pos = [
        [C, C + 384, Math.PI],        // pid0 南：字顶朝 +Z（canvas 下）→ 转 180°
        [C + 384, C, Math.PI / 2],    // pid1 东：字顶朝 +X（canvas 右）→ 转 +90°
        [C, C - 384, 0],              // pid2 北：字顶朝 -Z（canvas 上）
        [C - 384, C, -Math.PI / 2],   // pid3 西：字顶朝 -X（canvas 左）→ 转 -90°
      ];
      for (let pid = 0; pid < 4; pid++) {
        const [x, y, rot] = pos[pid];
        const active = pid === this._compassTurn;
        g.save();
        g.translate(x, y);
        g.rotate(rot);
        g.font = '700 128px "STKaiti","KaiTi","Kaiti SC",serif';
        if (active) {
          g.shadowColor = 'rgba(255,200,90,0.95)';
          g.shadowBlur = 52;
          g.fillStyle = '#ffe9b0';
        } else {
          g.shadowBlur = 0;
          g.fillStyle = gold(0.42);
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
        color: theme().gold, emissive: 0xaa7a20, emissiveIntensity: 0.9,
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

    /** 手牌第 i 张立牌坐标（从左到右升序；摸牌固定最右并留 DRAW_GAP 间距。
        fresh 及其右侧全部让位 —— 即便引擎尚未理牌也不会发生重叠。
        我方立牌前倾（牌面指向高机位），厚度居中后竖向半跨 0.618，
        y=0.64 恰使牌底贴桌（0.02）；AI 立牌后仰，y=TILE_H/2 微沉即可。 */
    handSlot(pid, i, count) {
      const t = TAN[pid], d = SEAT_DIR[pid];
      const L = this._seatLayout(pid);
      const fresh = (this._handInfo[pid] || {}).fresh;
      const along = L.start + TILE_W / 2 + i * HAND_PITCH
        + (fresh >= 0 && i >= fresh ? DRAW_GAP : 0);
      const base = R_HAND + TILE_D / 2;
      const ty = pid === 0 ? 0.64 : TILE_H / 2 + 0.02;
      return new T.Vector3(
        t.x * along + d.x * base,
        ty,
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

    /** 副露同步：与手牌同一条桌沿基准线（手牌左、副露右）。
        被鸣牌绕局部 Z 轴（牌面法线 = 世界 +Y）横置 90° —— 花色面永远朝上，
        绝不侧翻成白块；横置牌沿桌沿占用宽度变为 TILE_H，用精确游标累加，
        杜绝与邻牌穿模。暗杠两端 rotateY(π) 翻面（牌背朝上、高度不变）。 */
    syncMelds(pid, melds) {
      const grp = this.groups[pid].meld;
      const q = FLAT_QUATS[pid];
      while (grp.children.length) {
        const m = grp.children.pop();
        killTweensOf(m.uuid);
        grp.remove(m);
      }
      const t = TAN[pid], d = SEAT_DIR[pid];
      /* 精确游标：每张牌按实际占地（横置 FOOT_H / 竖放 FOOT_W，含倒角外扩）+ GAP 累加 */
      const meldSpan = (m) => {
        const claimedIdx = m.from >= 0 ? m.tiles.indexOf(m.tile) : -1;
        return m.tiles.reduce((s, _, k) => s + (k === claimedIdx ? FOOT_H : FOOT_W), 0)
          + Math.max(0, m.tiles.length - 1) * GAP;
      };
      const total = melds.reduce((s, m) => s + meldSpan(m), 0)
        + Math.max(0, melds.length - 1) * GROUP_GAP;
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
        let cursor = acc;
        m.tiles.forEach((tIdx, k) => {
          const claimed = k === claimedIdx;
          const faceDown = isConcealedKong && (k === 0 || k === 3);
          const span = claimed ? TILE_H : TILE_W;
          const along = cursor + span / 2;
          cursor += span + GAP;
          // 横置牌径向占地变窄（TILE_W），沿 SEAT_DIR 微移使其底边与竖放牌平齐
          const depthOff = claimed ? (TILE_H - TILE_W) / 2 : 0;
          const base = R_HAND + TILE_D / 2 - depthOff;
          const ty = TILE_D / 2 + 0.02;
          const mesh = makeTile(tIdx, this.mats, this.MJ);
          mesh.quaternion.copy(q);
          if (claimed) { mesh.rotateZ(Math.PI / 2); claimedCount++; }  // 绕牌面法线横置：顶面仍朝上
          if (faceDown) mesh.rotateY(Math.PI);                         // 绕长轴翻面：牌背朝上
          mesh.position.set(t.x * along + d.x * base, ty, t.z * along + d.z * base);
          if (pulse) {
            mesh.position.y = ty + 0.9;
            tween(220, (e) => { mesh.position.y = ty + 0.9 * (1 - e); }, {
              delay: idx * 35, ease: easeOutCubic, tag: mesh.uuid,
            });
          }
          grp.add(mesh);
          idx++;
        });
        acc = cursor - GAP + GROUP_GAP;
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

    /* ---------- 主题皮肤 ---------- */

    /** 切换雀桌皮肤：绒毡重绘 + 木框/鎏金/牌背/雾色联动 + localStorage 持久化 */
    setTheme(name) {
      if (!THEMES[name]) return false;
      activeTheme = name;
      try { global.localStorage.setItem('mj-theme', name); } catch (e) { /* ignore */ }
      const th = theme();
      if (this._woodMat) this._woodMat.color.setHex(th.wood);
      if (this._woodHiMat) this._woodHiMat.color.setHex(th.woodHi);
      if (this._goldMat) this._goldMat.color.setHex(th.gold);
      if (this._floorMat) this._floorMat.color.setHex(th.floor);
      if (this._baseMat) this._baseMat.color.setHex(parseInt(th.feltOut.slice(1), 16));
      if (this.scene.fog) this.scene.fog.color.setHex(th.floor);
      if (this.mats) this.mats.sideShell.color.setHex(th.shell);
      if (this._feltMat) {
        const tex = makeFeltTextures();
        this._feltMat.map = tex.map;
        this._feltMat.bumpMap = tex.bump;
        this._feltMat.needsUpdate = true;
      }
      this._drawCompass();
      return true;
    }

    /** 循环切换到下一套皮肤，返回其显示名 */
    cycleTheme() {
      const idx = THEME_ORDER.indexOf(activeTheme);
      const next = THEME_ORDER[(idx + 1) % THEME_ORDER.length];
      this.setTheme(next);
      return THEMES[next].name;
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
          const m = tr.match(/matrix(?:3d)?\(([^)]+)\)/);
          if (m) {
            const parts = m[1].split(',').map(parseFloat);
            const a = parts[0], b = parts[1];
            deg = Math.round(Math.atan2(b, a) * 180 / Math.PI);
          }
        }
      }
      const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
      const dx = sx - cx, dy = sy - cy;
      /* 关键：旋转 90° 时屏幕盒宽高互换 —— 物理宽 r.width = 逻辑高，
         物理高 r.height = 逻辑宽。逻辑轴的跨度必须取对应的物理轴长度：
         逻辑 x 轴映射到屏幕竖直方向（dy），其半跨 = 物理高/2；
         逻辑 y 轴映射到屏幕水平方向（dx），其半跨 = 物理宽/2。
         （旧实现 deg=90 分支误用 r.width/r.height 当逻辑跨度，
          导致竖屏下 NDC 恒错、射线永远打不到手牌 —— 移动端无法出牌的根因） */
      const rot = deg === 90 || deg === -90 || deg === 270;
      const lw = rot ? r.height : r.width;   // 逻辑宽（= offsetWidth）
      const lh = rot ? r.width : r.height;   // 逻辑高（= offsetHeight）
      let lx, ly;
      if (deg === 90) { lx = lw / 2 + dy; ly = lh / 2 - dx; }
      else if (deg === -90 || deg === 270) { lx = lw / 2 - dy; ly = lh / 2 + dx; }
      else if (deg === 180) { lx = lw / 2 - dx; ly = lh / 2 - dy; }
      else { lx = lw / 2 + dx; ly = lh / 2 + dy; }
      return { x: lx, y: ly, w: lw, h: lh };
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
    /** 可用皮肤清单（供 🎨 按钮提示） */
    themeList() {
      return THEME_ORDER.map((id) => ({ id, name: THEMES[id].name }));
    },
    currentTheme() {
      return activeTheme;
    },
  };

  global.MJTable3D = API;
})(typeof window !== 'undefined' ? window : globalThis);
