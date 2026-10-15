/**
 * table3d.js — Three.js 真 3D 牌桌渲染器（HUD 2D 浮层 + 3D 立体场景）
 *
 * 职责：
 *   ① 3D 麻将桌台：深蓝绒布桌面 + 鎏金木质边框 + 中央下沉式八角电子风位罗盘
 *   ② 真六面体双层麻将块：象牙骨瓷白牌肉(72%) + 琥珀朱红背壳(28%)，
 *      正面贴 tiles.js 的 SVG 高清 CanvasTexture（零外部图片素材）
 *   ③ 四家三维布局：牌河 6×3 平铺 / 手牌桌沿立牌 / 副露横置被鸣牌
 *   ④ 《雀魂》风 3D 手部（HandActor）：摸牌推入 / 拍牌出牌(320ms 抛物线+翻面+
 *      落桌冲击波) / 吃碰杠挥手 + 镜头震动
 *   ⑤ Raycaster 射线选牌（我方手牌：悬停升起 / 单击选中 / 再击出牌）
 *
 * 降级：无 WebGL / 构造异常时 mount() 返回 null，ui.js 自动回退平面 DOM 渲染。
 * 坐标系：与「横屏逻辑视口」一致 —— 画布在 #app 旋转容器内按布局尺寸工作，
 *         竖屏时 CSS 旋转由外层完成，Three 只需按容器逻辑宽高 setSize。
 */
(function (global) {
  'use strict';

  const T = global.THREE;
  if (!T) return;

  /* ================= 常量 ================= */
  const TILE_W = 2.2, TILE_H = 3.0, TILE_D = 1.6;   // 宽:高:厚 = 2.2:3.0:1.6
  const BODY_D = 1.12, SHELL_D = 0.50;              // 牌肉 / 背壳分层（72% / 28%）
  const TILE_R = 0.26, BEVEL = 0.055;               // 圆角与倒角

  const RIVER_COLS = 6, RIVER_ROWS = 3;
  const RX = TILE_W + 0.18, RZ = TILE_H + 0.18;     // 牌河间距
  const HAND_PITCH = TILE_W + 0.34;                 // 手牌间距（第 14 张摸牌距见 drawGap）
  const DRAW_GAP = 0.4;                             // 摸牌自动留出的间距

  const RIVER_INNER = 4.6;                          // 牌河内缘距桌心
  const HAND_Z = RIVER_INNER + RIVER_ROWS * RZ + 3.2;  // 手牌立牌桌沿
  const MELD_Z = HAND_Z - 2.6;                      // 副露行（手牌与牌河之间）
  const MELD_X0 = 9.4;                              // 副露起点（向右铺）

  const COL = {
    felt: 0x0d2c55, feltHi: 0x123562,
    wood: 0x6d4a22, woodHi: 0x8a5f2c, gold: 0xd8b46c,
    ivory: 0xf5eedc, shell: 0x9b2d1f,
    skin: 0xf2cba2, skinDark: 0xd9a878,
    compass: 0x0a0f26, compassRim: 0xd8b46c,
  };

  /* 座位几何：0=我(南,面朝镜头) 1=右家(东) 2=对家(北) 3=左家(西) */
  const SEAT_YAW = [0, -Math.PI / 2, Math.PI, Math.PI / 2];
  /** 每座位「朝向桌心」的单位向量（俯视） */
  const SEAT_DIR = [
    { x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 }, { x: 1, z: 0 },
  ];

  /* ================= 小工具 ================= */
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
  const easeInOutQuad = (t) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  const easeOutBack = (t) => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };

  /* ---- 微型补间系统（RAF 驱动） ---- */
  const tweens = [];
  function tween(dur, onUpdate, opts) {
    opts = opts || {};
    const tw = {
      t0: performance.now() + (opts.delay || 0),
      dur, onUpdate, onDone: opts.onDone || null,
      ease: opts.ease || easeOutCubic, dead: false,
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

  /* ---- 麻将块几何（共享） ---- */
  let _bodyGeo = null, _shellGeo = null;
  function bodyGeo() {
    if (!_bodyGeo) {
      _bodyGeo = extrudeRounded(TILE_W, TILE_H, TILE_R, BODY_D, BEVEL);
      // 正面（normal.z>0.5）UV 归一到 0..1，供牌面贴图使用
      const pos = _bodyGeo.attributes.position, uv = _bodyGeo.attributes.uv;
      const n = _bodyGeo.attributes.normal;
      for (let i = 0; i < uv.count; i++) {
        if (n.getZ(i) > 0.5) {
          uv.setXY(i, pos.getX(i) / TILE_W + 0.5, pos.getY(i) / TILE_H + 0.5);
        }
      }
      uv.needsUpdate = true;
    }
    return _bodyGeo;
  }
  function shellGeo() {
    if (!_shellGeo) {
      _shellGeo = extrudeRounded(TILE_W, TILE_H, TILE_R, SHELL_D - BEVEL * 2, BEVEL);
      _shellGeo.rotateX(Math.PI);          // 翻转使「正面」朝 -z（背壳朝外）
      _shellGeo.translate(0, 0, 0.012);    // 与牌肉背面留极小缝，避免共面闪烁
    }
    return _shellGeo;
  }

  /* ================= 纹理 ================= */

  /** 34 种牌面 CanvasTexture 缓存（SVG → 离屏 canvas 256×348） */
  const faceTexCache = new Map();
  function faceTexture(tileIndex, MJ) {
    let tex = faceTexCache.get(tileIndex);
    if (tex) return tex;
    const cw = 256, ch = 348;
    const cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    const g = cv.getContext('2d');
    g.fillStyle = '#f6efdd';
    g.fillRect(0, 0, cw, ch);
    // 浅凹内阴影（模拟阴刻凹槽）
    g.strokeStyle = 'rgba(120,96,60,.20)';
    g.lineWidth = 6;
    g.strokeRect(9, 9, cw - 18, ch - 18);
    g.strokeStyle = 'rgba(255,255,255,.55)';
    g.lineWidth = 2;
    g.strokeRect(13, 13, cw - 26, ch - 26);
    const svg = MJ.tileFaceSVG(tileIndex);
    const img = new Image();
    tex = new T.CanvasTexture(cv);
    tex.anisotropy = 4;
    tex.encoding = T.sRGBEncoding;
    tex._ready = false;
    img.onload = () => {
      g.drawImage(img, 14, 14, cw - 28, ch - 28);
      tex.needsUpdate = true;
      tex._ready = true;
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    faceTexCache.set(tileIndex, tex);
    return tex;
  }

  /** 文字纹理（罗盘发光字 / 其它 UI 贴图） */
  function textTexture(str, opt) {
    opt = opt || {};
    const cv = document.createElement('canvas');
    cv.width = opt.w || 128; cv.height = opt.h || 128;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, cv.width, cv.height);
    g.font = (opt.weight || 700) + ' ' + (opt.size || 84) + 'px "STKaiti","KaiTi","Kaiti SC","楷体",serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    if (opt.glow) { g.shadowColor = opt.glow; g.shadowBlur = 22; }
    g.fillStyle = opt.color || '#ffe9b0';
    g.fillText(str, cv.width / 2, cv.height / 2 + (opt.dy || 0));
    const tex = new T.CanvasTexture(cv);
    tex.encoding = T.sRGBEncoding;
    tex.anisotropy = 4;
    return tex;
  }

  /* ================= 麻将块 Mesh ================= */

  /**
   * 双层六面体麻将块。
   * local：+z 为牌面法线、+y 为牌面「上」方向、y∈[0,厚]（底部贴桌面时用姿态四元数摆放）。
   */
  function makeTile(tileIndex, mats, MJ) {
    const g = new T.Group();
    const body = new T.Mesh(bodyGeo(), [mats.face(tileIndex), mats.sideIvory]);
    body.position.z = SHELL_D - 0.02;
    body.castShadow = true; body.receiveShadow = true;
    const shell = new T.Mesh(shellGeo(), mats.sideShell);
    shell.castShadow = true; shell.receiveShadow = true;
    g.add(shell); g.add(body);
    g.userData.tileIndex = tileIndex;
    g.userData.body = body;
    return g;
  }

  /** 平铺（牌面朝上）：先翻平再绕世界 Y 转座位朝向 */
  const _qTmp = new T.Quaternion(), _qFlat = new T.Quaternion(), _qYaw = new T.Quaternion();
  const _eX = new T.Euler();
  function flatQuat(yaw) {
    _eX.set(-Math.PI / 2, 0, 0);
    _qFlat.setFromEuler(_eX);
    _qYaw.setFromAxisAngle(new T.Vector3(0, 1, 0), yaw);
    return _qTmp.copy(_qYaw).multiply(_qFlat).clone();
  }
  const FLAT_QUATS = SEAT_YAW.map(flatQuat);

  /* ================= 3D 手部（HandActor） ================= */

  const HAND_MAT = {
    skin: null, skinDark: null, gold: null, cuff: null,
  };
  function handMats() {
    if (!HAND_MAT.skin) {
      HAND_MAT.skin = new T.MeshStandardMaterial({ color: COL.skin, roughness: 0.55, metalness: 0.02 });
      HAND_MAT.skinDark = new T.MeshStandardMaterial({ color: COL.skinDark, roughness: 0.6, metalness: 0.02 });
      HAND_MAT.gold = new T.MeshStandardMaterial({ color: COL.gold, roughness: 0.25, metalness: 0.65 });
      HAND_MAT.cuff = new T.MeshStandardMaterial({ color: 0x14264d, roughness: 0.5, metalness: 0.15 });
    }
    return HAND_MAT;
  }

  class HandActor {
    constructor(seat) {
      this.seat = seat;
      this.mats = handMats();
      this.root = new T.Group();
      this.root.visible = false;
      this._build();
      this.busy = false;
    }

    _build() {
      const M = this.mats;
      const g = new T.Group();          // 手掌局部系：指尖朝 +z，腕在 -z
      // 手掌：压扁球体
      const palm = new T.Mesh(new T.SphereGeometry(0.85, 20, 14), M.skin);
      palm.scale.set(1.0, 0.42, 1.25);
      palm.position.set(0, 0, 0);
      palm.castShadow = true;
      g.add(palm);
      // 四指（带第一关节弯曲）
      for (let i = 0; i < 4; i++) {
        const f = new T.Mesh(new T.CapsuleGeometry(0.13, 0.55, 4, 10), i % 2 ? M.skinDark : M.skin);
        f.rotation.x = Math.PI / 2 - 0.35;      // 指尖前伸并微微下扣
        f.position.set(-0.48 + i * 0.32, 0.08, 1.18);
        f.castShadow = true;
        g.add(f);
        const tip = new T.Mesh(new T.CapsuleGeometry(0.115, 0.3, 4, 8), M.skinDark);
        tip.rotation.x = Math.PI / 2 - 0.75;
        tip.position.set(-0.48 + i * 0.32, -0.06, 1.72);
        g.add(tip);
      }
      // 拇指
      const thumb = new T.Mesh(new T.CapsuleGeometry(0.15, 0.5, 4, 10), M.skin);
      thumb.rotation.set(Math.PI / 2 - 0.4, 0, -0.9);
      thumb.position.set(-0.82, 0.1, 0.55);
      thumb.castShadow = true;
      g.add(thumb);
      // 手腕玉镯 + 袖口
      const bangle = new T.Mesh(new T.TorusGeometry(0.52, 0.075, 10, 24), M.gold);
      bangle.rotation.x = Math.PI / 2;
      bangle.position.set(0, 0, -0.85);
      g.add(bangle);
      const cuff = new T.Mesh(new T.CylinderGeometry(0.6, 0.72, 0.7, 20), M.cuff);
      cuff.rotation.x = Math.PI / 2;
      cuff.position.set(0, 0, -1.3);
      cuff.castShadow = true;
      g.add(cuff);
      this.hand = g;
      this.root.add(g);
    }

    /** 待机位：桌沿外侧、手背朝上悬停 */
    restPos() {
      const d = SEAT_DIR[this.seat];
      const r = HAND_Z + 2.4;
      return new T.Vector3(d.x * 0, 1.1, 0).add(new T.Vector3(d.x * 0, 0, d.z * r)).add(new T.Vector3(d.x * (this.seat % 2 ? 0 : 4.5), 0, d.z * 0));
    }

    /** 出牌：伸向手牌区拈牌 → 抛物线抬升翻面 → 拍落牌河格位 */
    playDiscard(ctx, onLand) {
      if (this.busy) { if (onLand) onLand(); return; }
      this.busy = true;
      const seat = this.seat;
      const d = SEAT_DIR[seat];
      const yaw = SEAT_YAW[seat];
      const from = ctx.fromPos;         // 手牌区拈牌点（世界系）
      const to = ctx.toPos;             // 牌河落点（世界系）
      const yawQ = flatQuat(yaw);

      // 手从桌沿外伸入拈牌点
      const rest = this.restPos();
      this.root.visible = true;
      this.root.position.copy(rest);
      const grab = rest.clone().lerp(new T.Vector3(from.x, from.y + 0.6, from.z), 0.9);

      const tile = ctx.tileMesh;        // 由外部创建的携带牌（已入场景）
      tile.visible = false;

      tween(150, (k) => {
        this.root.position.lerpVectors(rest, grab, k);
      }, {
        ease: easeOutCubic, tag: 'hand' + seat,
        onDone: () => {
          // 拈住牌，沿贝塞尔抛物线飞向牌河
          tile.visible = true;
          const apex = new T.Vector3(
            from.x * 0.35 + to.x * 0.65,
            Math.max(from.y, to.y) + 4.6,
            from.z * 0.35 + to.z * 0.65);
          const p0 = from.clone(), p2 = to.clone();
          const q0 = tile.quaternion.clone();
          const q1 = yawQ.clone();
          const slamT = 230, flyT = 200;
          tween(flyT, (k) => {
            const a = p0.clone().lerp(apex, k);
            const b = apex.clone().lerp(p2, k);
            tile.position.copy(a.lerp(b, k));
            tile.quaternion.slerpQuaternions(q0, q1, clamp(k * 1.25, 0, 1));
          }, {
            ease: easeInOutQuad, tag: 'hand' + seat,
            onDone: () => {
              // 「啪」拍落：快速下压 + 手收回
              tween(slamT, (k) => {
                tile.position.y = p2.y + (1 - k) * 0.5;
                this.root.position.lerpVectors(grab, rest, k);
                this.root.visible = k < 0.98;
              }, {
                ease: easeOutCubic, tag: 'hand' + seat,
                onDone: () => {
                  tile.visible = false;   // 真牌由牌河组接棒显示
                  this.busy = false;
                  if (onLand) onLand();
                },
              });
            },
          });
        },
      });
    }

    /** 摸牌：手从牌桌中央轻推新牌入手牌最右 */
    playDraw(ctx) {
      if (this.busy) return;
      this.busy = true;
      const seat = this.seat;
      const rest = this.restPos();
      const d = SEAT_DIR[seat];
      const at = new T.Vector3(ctx.toPos.x - d.x * 6, ctx.toPos.y + 1.2, ctx.toPos.z - d.z * 6);
      this.root.visible = true;
      this.root.position.copy(rest);
      tween(110, (k) => { this.root.position.lerpVectors(rest, at, k); }, {
        ease: easeOutCubic, tag: 'hand' + seat,
        onDone: () => {
          tween(110, (k) => { this.root.position.lerpVectors(at, rest, k); }, {
            ease: easeInOutQuad, tag: 'hand' + seat,
            onDone: () => { this.root.visible = false; this.busy = false; },
          });
        },
      });
    }

    /** 吃 / 碰 / 杠：一挥手 + 镜头轻震（牌组重排由 sync 完成） */
    playClaim(ctx) {
      if (this.busy) return;
      this.busy = true;
      const seat = this.seat;
      const rest = this.restPos();
      const d = SEAT_DIR[seat];
      const sweepTo = new T.Vector3(ctx.toPos.x, 2.2, ctx.toPos.z);
      this.root.visible = true;
      this.root.position.copy(rest);
      tween(190, (k) => { this.root.position.lerpVectors(rest, sweepTo, k); }, {
        ease: easeOutCubic, tag: 'hand' + seat,
        onDone: () => {
          tween(210, (k) => { this.root.position.lerpVectors(sweepTo, rest, k); }, {
            ease: easeInOutQuad, tag: 'hand' + seat,
            onDone: () => { this.root.visible = false; this.busy = false; },
          });
        },
      });
    }

    dispose() {
      killTweensOf('hand' + this.seat);
      this.root.visible = false;
      this.busy = false;
    }
  }

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
      this.scene.fog = new T.Fog(0x05070f, 60, 140);

      this.camera = new T.PerspectiveCamera(46, 1, 0.1, 400);
      this.camShake = 0;

      this._buildLights();
      this._buildTable();
      this._buildCompass();
      this._buildGroups();
      this._buildHands();
      this._buildCursor();

      /* ---- 材质库 ---- */
      const sideIvory = new T.MeshStandardMaterial({ color: COL.ivory, roughness: 0.25, metalness: 0.05 });
      const sideShell = new T.MeshStandardMaterial({ color: COL.shell, roughness: 0.18, metalness: 0.08 });
      const faceMatCache = new Map();
      this.mats = {
        sideIvory, sideShell,
        face: (idx) => {
          let m = faceMatCache.get(idx);
          if (!m) {
            m = new T.MeshStandardMaterial({
              map: faceTexture(idx, MJ), roughness: 0.28, metalness: 0.04,
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
      const hemi = new T.HemisphereLight(0xbfd8ff, 0x3a2a18, 0.85);
      this.scene.add(hemi);
      const spot = new T.SpotLight(0xfff2dc, 1.15, 160, Math.PI / 3.4, 0.45, 1.2);
      spot.position.set(7, 42, 10);
      spot.castShadow = true;
      spot.shadow.mapSize.set(2048, 2048);
      spot.shadow.bias = -0.0006;
      this.scene.add(spot);
      this.scene.add(spot.target);
      const warm = new T.PointLight(0xffd9a0, 0.55, 60);
      warm.position.set(0, 10, 14);
      this.scene.add(warm);
    }

    _buildTable() {
      // 绒布桌面（圆角矩形，微微下沉的厚墩）
      const fw = HAND_Z * 2 + 11, fh = HAND_Z * 2 + 11;
      const feltGeo = extrudeRounded(fw, fh, 4.5, 0.8, 0.3);
      feltGeo.rotateX(-Math.PI / 2);
      const felt = new T.Mesh(feltGeo, new T.MeshStandardMaterial({
        color: COL.felt, roughness: 0.95, metalness: 0,
      }));
      felt.position.y = -0.8;
      felt.receiveShadow = true;
      this.scene.add(felt);
      // 中心的亮一圈（渐变高光贴片）
      const hi = new T.Mesh(
        new T.CircleGeometry(14, 48),
        new T.MeshBasicMaterial({ color: COL.feltHi, transparent: true, opacity: 0.35 }));
      hi.rotation.x = -Math.PI / 2;
      hi.position.y = 0.012;
      this.scene.add(hi);
      // 鎏金木质边框（四条）
      const woodMat = new T.MeshStandardMaterial({ color: COL.wood, roughness: 0.42, metalness: 0.25 });
      const rimMat = new T.MeshStandardMaterial({ color: COL.gold, roughness: 0.3, metalness: 0.6 });
      const bw = 2.4, bh = 1.5;
      const half = fw / 2 + bw / 2;
      [[0, -half, fw + bw * 2, bw], [0, half, fw + bw * 2, bw]].forEach(([x, z, w, d]) => {
        const m = new T.Mesh(new T.BoxGeometry(w, bh, d), woodMat);
        m.position.set(x, bh / 2 - 0.9, z);
        m.castShadow = true; m.receiveShadow = true;
        this.scene.add(m);
        const trim = new T.Mesh(new T.BoxGeometry(w * 0.99, 0.22, 0.34), rimMat);
        trim.position.set(x, bh - 0.75, z + (z > 0 ? -d / 2 - 0.05 : d / 2 + 0.05));
        this.scene.add(trim);
      });
      [[-half, 0, bw, fh], [half, 0, bw, fh]].forEach(([x, z, w, d]) => {
        const m = new T.Mesh(new T.BoxGeometry(w, bh, d), woodMat);
        m.position.set(x, bh / 2 - 0.9, z);
        m.castShadow = true; m.receiveShadow = true;
        this.scene.add(m);
        const trim = new T.Mesh(new T.BoxGeometry(0.34, 0.22, fh * 0.99), rimMat);
        trim.position.set(x + (x > 0 ? -w / 2 - 0.05 : w / 2 + 0.05), bh - 0.75, z);
        this.scene.add(trim);
      });
    }

    _buildCompass() {
      const g = new T.Group();
      // 底座（金圈）+ 黑金八角盘（下沉）
      const rim = new T.Mesh(
        new T.CylinderGeometry(4.35, 4.55, 0.5, 8),
        new T.MeshStandardMaterial({ color: COL.compassRim, roughness: 0.3, metalness: 0.7 }));
      rim.position.y = 0.1;
      rim.receiveShadow = true;
      g.add(rim);
      const plate = new T.Mesh(
        new T.CylinderGeometry(4.0, 4.0, 0.42, 8),
        new T.MeshStandardMaterial({ color: COL.compass, roughness: 0.35, metalness: 0.4 }));
      plate.position.y = 0.14;
      plate.receiveShadow = true;
      g.add(plate);
      // 发光「电子网格」顶面
      const gridTex = this._gridTexture();
      const top = new T.Mesh(
        new T.CircleGeometry(3.75, 8),
        new T.MeshBasicMaterial({ map: gridTex, transparent: true, opacity: 0.9 }));
      top.rotation.x = -Math.PI / 2;
      top.rotation.z = Math.PI / 8;
      top.position.y = 0.365;
      g.add(top);
      // 四方座位指示灯（当前行动家点亮；文字信息由 2D 铭牌承担，避免重叠）
      this.windBlocks = [];
      const dotGeo = new T.SphereGeometry(0.28, 14, 10);
      for (let i = 0; i < 4; i++) {
        const mat = new T.MeshStandardMaterial({
          color: 0x37507a, emissive: 0x000000, emissiveIntensity: 0,
          roughness: 0.4, metalness: 0.3,
        });
        const dot = new T.Mesh(dotGeo, mat);
        const d = SEAT_DIR[i];
        dot.position.set(d.x * 3.2, 0.44, d.z * 3.2);
        g.add(dot);
        this.windBlocks.push({ mesh: dot, mat });
      }
      this.scene.add(g);
      this.compass = g;
    }

    _gridTexture() {
      const cv = document.createElement('canvas');
      cv.width = cv.height = 256;
      const g = cv.getContext('2d');
      g.fillStyle = 'rgba(6,10,24,.92)';
      g.fillRect(0, 0, 256, 256);
      g.strokeStyle = 'rgba(120,160,220,.30)';
      g.lineWidth = 1;
      for (let i = 0; i <= 256; i += 16) {
        g.beginPath(); g.moveTo(i, 0); g.lineTo(i, 256); g.stroke();
        g.beginPath(); g.moveTo(0, i); g.lineTo(256, i); g.stroke();
      }
      g.strokeStyle = 'rgba(216,180,108,.5)';
      g.lineWidth = 3;
      g.beginPath(); g.arc(128, 128, 96, 0, Math.PI * 2); g.stroke();
      g.beginPath(); g.arc(128, 128, 60, 0, Math.PI * 2); g.stroke();
      const tex = new T.CanvasTexture(cv);
      tex.encoding = T.sRGBEncoding;
      return tex;
    }

    _buildGroups() {
      this.groups = [];
      for (let pid = 0; pid < 4; pid++) {
        this.groups.push({
          hand: new T.Group(), river: new T.Group(), meld: new T.Group(),
        });
        this.scene.add(this.groups[pid].hand, this.groups[pid].river, this.groups[pid].meld);
      }
      /* 光标（金色四棱锥，悬浮于最新弃牌上） */
    }

    _buildHands() {
      this.hands = [];
      for (let pid = 0; pid < 4; pid++) {
        const h = new HandActor(pid);
        this.hands.push(h);
        this.scene.add(h.root);
      }
    }

    _buildCursor() {
      const mat = new T.MeshStandardMaterial({
        color: COL.gold, emissive: 0xaa7a20, emissiveIntensity: 0.9,
        roughness: 0.25, metalness: 0.7,
      });
      this.cursor = new T.Mesh(new T.ConeGeometry(0.55, 1.0, 4), mat);
      this.cursor.rotation.x = Math.PI;
      this.cursor.visible = false;
      this.scene.add(this.cursor);
    }

    /* ---------- 布局 ---------- */

    /** 牌河第 i 张的世界坐标（平铺） */
    riverSlot(pid, i) {
      const col = i % RIVER_COLS, row = (i / RIVER_COLS) | 0;
      const d = SEAT_DIR[pid];
      // 内缘 → 外缘铺；列沿切向展开
      const tangent = { x: -d.z, z: d.x };
      const along = (col - (RIVER_COLS - 1) / 2) * RX;
      const out = RIVER_INNER + (row + 0.5) * RZ;
      return new T.Vector3(
        tangent.x * along + d.x * out,
        TILE_D / 2 + 0.02,
        tangent.z * along + d.z * out);
    }

    /** 手牌第 i 张立牌坐标（含摸牌第 14 张的额外间距） */
    handSlot(pid, i, count) {
      const d = SEAT_DIR[pid];
      const tangent = { x: -d.z, z: d.x };
      const gap = (pid === 0 && count >= 14 && i === count - 1) ? DRAW_GAP : 0;
      const along = (i - (count - 1) / 2) * HAND_PITCH + gap;
      const base = HAND_Z + TILE_D / 2;
      return new T.Vector3(
        tangent.x * along + d.x * base,
        TILE_H / 2 + 0.02,
        tangent.z * along + d.z * base);
    }

    /* ---------- 同步（由 ui.js 调） ---------- */

    /** 手牌立牌同步：diff 复用 mesh，新牌可播放入场 */
    syncHand(pid, tiles, opts) {
      opts = opts || {};
      const grp = this.groups[pid].hand;
      const yaw = SEAT_YAW[pid];
      // 我方手牌面朝镜头(yaw 0)；AI 手牌牌背朝桌心 → 面朝外
      const standYaw = pid === 0 ? 0 : yaw;
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
          if (opts.animate) {
            const target = this.handSlot(pid, i, tiles.length);
            mesh.position.set(target.x, target.y + 6, target.z);
            mesh.quaternion.setFromEuler(new T.Euler(0, standYaw, 0));
            tween(340, (k) => { mesh.position.y = target.y + 6 * (1 - k); }, {
              delay: i * 34, ease: easeOutCubic, tag: mesh.uuid,
            });
            return;
          }
        }
        // 更新：牌面 / 位置（数量变化时重排）
        if (mesh.userData.tileIndex !== tIdx) {
          mesh.userData.tileIndex = tIdx;
          mesh.userData.body.material[0] = this.mats.face(tIdx);
        }
        const target = this.handSlot(pid, i, tiles.length);
        if (!mesh.position.equals(target)) mesh.position.copy(target);
        mesh.quaternion.setFromEuler(new T.Euler(0, standYaw, 0));
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

    /** 牌河同步；pendingPid 的最后一张先隐藏，等手部落桌后 reveal（按座位分槽） */
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
              mesh.position.y = target.y + 3;
              tween(180, (k) => { mesh.position.y = target.y + 3 * (1 - k); }, {
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
            if (old && old.mesh !== mesh) old.mesh.visible = true;   // 同座位连续出牌：旧 pending 立即揭示，防永久隐藏
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
          this.cursor.position.set(top.x, TILE_D + 1.3, top.z);
          this._cursorTile = top;
        }
      }
      if (cursorPid < 0 || !discards[cursorPid] || !discards[cursorPid].length) {
        this.cursor.visible = false;
      }
    }

    /** 副露同步（含横置被鸣牌 / 暗杠两端翻面）：组沿切向累计排开，超出换行 */
    syncMelds(pid, melds) {
      const grp = this.groups[pid].meld;
      const q = FLAT_QUATS[pid];
      while (grp.children.length) grp.remove(grp.children.pop());
      const d = SEAT_DIR[pid];
      const tangent = { x: -d.z, z: d.x };
      const WRAP_AT = 21;                       // 切向超过此值换行（换到更外侧一行）
      const ROW_OUT = 2.7;                      // 行间距（沿朝向桌心方向）
      let cursor = 5.6, row = 0, claimedCount = 0;
      grp.userData.groupCount = melds.length;
      melds.forEach((m) => {
        const groupW = m.tiles.length * (TILE_W + 0.12) + 0.5;
        if (cursor + groupW > WRAP_AT) { cursor = 5.6; row++; }
        // 被鸣牌下标：吃牌的被鸣牌通常在中间（如 2p[3p]4p），碰/杠则在第 0 张
        const claimedIdx = m.from >= 0 ? m.tiles.indexOf(m.tile) : -1;
        m.tiles.forEach((tIdx, k) => {
          const claimed = k === claimedIdx;
          const isConcealedKong = m.kind === 'concealed_kong' ||
            (m.tiles.length === 4 && m.from < 0 && !m.added);
          const faceDown = isConcealedKong && (k === 0 || k === 3);
          const mesh = makeTile(tIdx, this.mats, this.MJ);
          mesh.quaternion.copy(q);
          if (claimed) { mesh.rotateY(Math.PI / 2); claimedCount++; }   // 被鸣牌横置 90°
          if (faceDown) mesh.rotateX(Math.PI);           // 暗杠两端牌背朝上
          const off = (k - (m.tiles.length - 1) / 2) * (TILE_W + 0.12)
            + (claimed ? (TILE_W + 0.12) * 0.3 : 0);
          const out = MELD_Z + row * ROW_OUT;
          mesh.position.set(
            tangent.x * (cursor + off) + d.x * out,
            TILE_D / 2 + 0.02,
            tangent.z * (cursor + off) + d.z * out);
          grp.add(mesh);
        });
        cursor += groupW;
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
        const lift = (i === this.selectedIdx) ? 0.45 : (i === this.hoverIdx ? 0.22 : 0);
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
      this.windBlocks.forEach((b, i) => {
        const active = i === pid;
        b.mat.emissive.setHex(active ? 0xffb84d : 0x000000);
        b.mat.emissiveIntensity = active ? 1.1 : 0;
        b.mat.color.setHex(active ? 0xffd98c : 0x37507a);
      });
    }

    /* ---------- 3D 手部动画入口 ---------- */

    /** 出牌：从手牌区拈起一张临时牌拍向牌河；onLand 时揭示真牌 */
    playDiscard(pid, discards, cursorPid) {
      const handCount = this.myHandTiles ? this.myHandTiles.length + 1 : 14;
      const fromPos = this.handSlot(pid, Math.min(13, handCount - 1), handCount).clone();
      fromPos.y = TILE_H / 2 + 0.6;
      const i = discards[pid].length - 1;
      const toPos = this.riverSlot(pid, i).clone();
      const tileIdx = discards[pid][i];
      const carried = makeTile(tileIdx, this.mats, this.MJ);
      const q = FLAT_QUATS[pid];
      carried.position.copy(fromPos);
      carried.quaternion.setFromEuler(new T.Euler(0, pid === 0 ? 0 : SEAT_YAW[pid], 0));
      this.scene.add(carried);
      this.hands[pid].playDiscard({ fromPos, toPos, tileMesh: carried }, () => {
        this.scene.remove(carried);
        // 揭示牌河真牌 + 冲击波
        const pr = this._pending && this._pending[pid];
        if (pr) { pr.mesh.visible = true; delete this._pending[pid]; }
        this._shockwave(toPos);
        this._shake(0.5);
      });
    }

    /** 摸牌：手推入 */
    playDraw(pid) {
      const grp = this.groups[pid].hand;
      const i = grp.children.length - 1;
      const toPos = this.handSlot(pid, i, grp.children.length).clone();
      this.hands[pid].playDraw({ toPos });
    }

    /** 吃碰杠挥手 + 镜头震动 */
    playClaim(pid) {
      const d = SEAT_DIR[pid];
      const toPos = new T.Vector3(d.x * MELD_X0, 1.5, d.z * MELD_Z);
      this.hands[pid].playClaim({ toPos });
      this._shake(0.9);
    }

    /** 落点金色水波纹 */
    _shockwave(pos) {
      const ring = new T.Mesh(
        new T.RingGeometry(0.4, 0.85, 40),
        new T.MeshBasicMaterial({
          color: 0xffd98c, transparent: true, opacity: 0.95,
          side: T.DoubleSide, blending: T.AdditiveBlending, depthWrite: false,
        }));
      ring.rotation.x = -Math.PI / 2;
      ring.position.set(pos.x, 0.1, pos.z);
      this.scene.add(ring);
      tween(460, (k) => {
        ring.scale.setScalar(1 + k * 4.2);
        ring.material.opacity = 0.95 * (1 - k);
      }, { ease: easeOutCubic, onDone: () => this.scene.remove(ring) });
    }

    /** 镜头轻震 */
    _shake(power) {
      this.camShake = Math.min(1.4, this.camShake + power);
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

    _fitCamera() {
      const dir = new T.Vector3(0, 0.94, 0.72).normalize();
      const target = new T.Vector3(0, 0, 1.2);
      const cam = this.camera;
      cam.updateProjectionMatrix();
      // 包围盒（含立牌高度与副露外缘）
      const pts = [];
      const R = HAND_Z + 9;
      for (const x of [-R, R]) for (const z of [-R, R]) {
        pts.push(new T.Vector3(x, 0, z), new T.Vector3(x, TILE_H + 1.2, z));
      }
      let lo = 24, hi = 140;
      const proj = (dist) => {
        cam.position.copy(target).addScaledVector(dir, dist);
        cam.lookAt(target);
        cam.updateMatrixWorld();
        let ok = true;
        const v = new T.Vector3();
        for (const p of pts) {
          v.copy(p).project(cam);
          if (v.x < -0.97 || v.x > 0.97 || v.y < -0.97 || v.y > 0.97) { ok = false; break; }
        }
        return ok;
      };
      for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2;
        if (proj(mid)) hi = mid; else lo = mid;
      }
      this.camDist = hi;
      this._camBase = { target: target.clone(), dir, dist: hi };
      cam.position.copy(target).addScaledVector(dir, hi);
      cam.lookAt(target);
    }

    _tick(now) {
      // 光标浮动
      if (this.cursor.visible) {
        this.cursor.position.y = TILE_D + 1.3 + Math.sin(now / 380) * 0.28;
        this.cursor.rotation.y = now / 700;
      }
      // 镜头震动衰减
      if (this.camShake > 0.001) {
        this.camShake *= 0.86;
        const s = this.camShake;
        const base = this._camBase;
        this.camera.position.copy(base.target).addScaledVector(base.dir, base.dist);
        this.camera.position.x += (Math.random() - 0.5) * s * 0.7;
        this.camera.position.y += (Math.random() - 0.5) * s * 0.5;
        this.camera.lookAt(base.target);
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
      this.hands.forEach((h) => h.dispose());
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
