/**
 * tiles.js - 麻将牌定义、SVG 牌面渲染、合成音效
 * 零外部素材：所有牌面均由 SVG 矢量绘制，音效由 WebAudio 合成。
 * 美术：象牙牌面 + 鎏金描边 + 朱红/墨绿/靛蓝手绘纹样 + 书法汉字。
 * 同时兼容浏览器 (window.MJ) 与 Node (module.exports，供测试)。
 */
(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.MJ = Object.assign(global.MJ || {}, api);
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* --------------- 牌张定义 ---------------
   * 编号 0-33:
   *   0-8   一万~九万 (m)
   *   9-17  一筒~九筒 (p)
   *   18-26 一条~九条 (s)
   *   27-30 东南西北   (z)
   *   31 中  32 发  33 白
   */
  const SUIT_CHARS = ['m', 'p', 's', 'z'];
  const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const HONOR_NAMES = ['东', '南', '西', '北', '中', '发', '白'];

  function indexToTile(i) {
    if (i < 27) return (i % 9) + 1 + SUIT_CHARS[Math.floor(i / 9)];
    return i - 26 + 'z';
  }
  function tileToIndex(t) {
    const n = parseInt(t, 10);
    const s = t.slice(-1);
    if (s === 'z') return n + 26;
    return (n - 1) + SUIT_CHARS.indexOf(s) * 9;
  }
  function tileName(i) {
    if (i < 27) return CN_NUM[i % 9] + ['万', '筒', '条'][Math.floor(i / 9)];
    return HONOR_NAMES[i - 27];
  }
  const SUIT_OF = (i) => (i < 27 ? Math.floor(i / 9) : 3);
  const RANK_OF = (i) => (i < 27 ? i % 9 : -1);
  const isHonor = (i) => i >= 27;
  const isTerminal = (i) => i < 27 && (i % 9 === 0 || i % 9 === 8);
  const TOTAL_KINDS = 34;

  /* --------------- 视觉常量 --------------- */
  // 牌面画布 44 x 60 (宽高比 1:1.36)，所有坐标都基于此
  const VW = 44, VH = 60;

  const INK = '#1b1a17';   // 墨 (风牌)
  const RED = '#b0301f';   // 朱红 (万 / 中 / 高点)
  const GREEN = '#146b44'; // 墨绿 (条 / 发)
  const BLUE = '#1b5c97';  // 靛蓝 (筒)
  const IVORY = '#faf6ea';
  const GOLD = '#b9924e';
  const GOLD_LT = '#e3c68a';

  // 书法体优先，逐级回退到系统衬线体
  const FACE_FONT = "'STKaiti','KaiTi','Kaiti SC','楷体','STSong','SimSun','Songti SC','Noto Serif SC','Source Han Serif SC',serif";
  const NUM_FONT = "'STKaiti','KaiTi','Kaiti SC','楷体','STSong','SimSun','Songti SC',serif";

  /* --------------- 牌面底框 --------------- */
  function defs() {
    // 牌面渐变、立体斜面与背光内阴影定义（纯合法 SVG XML，无内联 C 注释）
    return (
      '<defs>' +
      '<linearGradient id="mjFace" x1="0" y1="0" x2="0.18" y2="1">' +
      '<stop offset="0" stop-color="#fffdf7"/><stop offset=".42" stop-color="#f6f0e0"/>' +
      '<stop offset="1" stop-color="#e5dcc4"/>' +
      '</linearGradient>' +
      '<linearGradient id="mjRim" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#e8cb92"/><stop offset=".42" stop-color="#c2a163"/>' +
      '<stop offset=".72" stop-color="#a2803f"/><stop offset="1" stop-color="#7a5d2c"/>' +
      '</linearGradient>' +
      '<linearGradient id="mjBevel" x1="0" y1="0" x2="0.22" y2="1">' +
      '<stop offset="0" stop-color="#ffffff" stop-opacity=".62"/>' +
      '<stop offset=".16" stop-color="#ffffff" stop-opacity=".06"/>' +
      '<stop offset=".78" stop-color="#6b5a35" stop-opacity="0"/>' +
      '<stop offset="1" stop-color="#5c4a26" stop-opacity=".34"/>' +
      '</linearGradient>' +
      '<linearGradient id="mjInnerShade" x1="0" y1="0" x2="0" y2="1">' +
      '<stop offset="0" stop-color="#3b2f16" stop-opacity="0"/>' +
      '<stop offset="1" stop-color="#3b2f16" stop-opacity=".22"/>' +
      '</linearGradient>' +
      '<linearGradient id="mjBack" x1="0" y1="0" x2="0.4" y2="1">' +
      '<stop offset="0" stop-color="#b8472f"/><stop offset=".46" stop-color="#932e21"/>' +
      '<stop offset="1" stop-color="#5c1811"/>' +
      '</linearGradient>' +
      '<linearGradient id="mjBackBevel" x1="0" y1="0" x2="0.24" y2="1">' +
      '<stop offset="0" stop-color="#ffffff" stop-opacity=".34"/>' +
      '<stop offset=".2" stop-color="#ffffff" stop-opacity=".04"/>' +
      '<stop offset=".8" stop-color="#2a0806" stop-opacity="0"/>' +
      '<stop offset="1" stop-color="#2a0806" stop-opacity=".4"/>' +
      '</linearGradient>' +
      '<linearGradient id="mjShine" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="#ffffff" stop-opacity=".5"/>' +
      '<stop offset=".38" stop-color="#ffffff" stop-opacity="0"/>' +
      '</linearGradient>' +
      '</defs>'
    );
  }

  /** 象牙牌面：鎏金外框 + 立体斜面 + 内细线 + 顶部高光 */
  function faceFrame(inner) {
    return (
      '<svg viewBox="0 0 ' + VW + ' ' + VH + '" xmlns="http://www.w3.org/2000/svg" class="tile-svg">' +
      defs() +
      // 鎏金外框（下缘渐深，形成牌缘的厚度）
      '<rect x="0.8" y="0.8" width="' + (VW - 1.6) + '" height="' + (VH - 1.6) + '" rx="6.2" fill="url(#mjRim)"/>' +
      // 象牙牌面
      '<rect x="2.6" y="2.4" width="' + (VW - 5.2) + '" height="' + (VH - 4.8) + '" rx="4.8" fill="url(#mjFace)"/>' +
      // 立体斜面：上缘受光、下缘背光
      '<rect x="2.6" y="2.4" width="' + (VW - 5.2) + '" height="' + (VH - 4.8) + '" rx="4.8" fill="url(#mjBevel)"/>' +
      // 牌面顶端受光棱线
      '<path d="M6.6 5.2 H' + (VW - 6.6) + '" stroke="#ffffff" stroke-opacity=".8" stroke-width="1" stroke-linecap="round"/>' +
      // 内细金线
      '<rect x="4.7" y="4.5" width="' + (VW - 9.4) + '" height="' + (VH - 9) + '" rx="3.2" fill="none" stroke="' + GOLD + '" stroke-opacity=".3" stroke-width="0.6"/>' +
      // 顶部高光
      '<rect x="2.6" y="2.4" width="' + (VW - 5.2) + '" height="26" rx="4.8" fill="url(#mjShine)" opacity=".55"/>' +
      // 牌面下缘内投影：让纹样区显得“凹进”牌面（置于纹样之下，不压暗数字）
      '<rect x="2.6" y="' + (VH - 20) + '" width="' + (VW - 5.2) + '" height="17.6" rx="4.4" fill="url(#mjInnerShade)"/>' +
      inner +
      '</svg>'
    );
  }

  /** 加粗描边后的文字，小尺寸下也清晰 */
  function glyph(ch, o) {
    return (
      '<text x="' + (o.x || VW / 2) + '" y="' + o.y + '" text-anchor="middle" ' +
      'font-family="' + (o.font || FACE_FONT) + '" font-size="' + o.size + '" ' +
      'font-weight="' + (o.weight || 700) + '" fill="' + o.color + '" ' +
      'stroke="' + o.color + '" stroke-width="' + (o.stroke === undefined ? 0.7 : o.stroke) + '" ' +
      'paint-order="stroke" stroke-linejoin="round"' +
      (o.spacing ? ' letter-spacing="' + o.spacing + '"' : '') +
      '>' + ch + '</text>'
    );
  }

  /* --------------- 万子 ---------------
   * 数字为墨黑，万 (萬) 字为朱红。
   */
  function manFace(i) {
    const n = i % 9;
    return faceFrame(
      glyph(CN_NUM[n], { y: 27.5, size: 19, color: INK, font: NUM_FONT, stroke: 0.8 }) +
      glyph('萬', { y: 51, size: 21, color: RED, stroke: 0.9 }) +
      '<path d="M11 33.5 C17 32 27 32 33 33.5" stroke="' + GOLD + '" stroke-opacity=".45" stroke-width="0.9" fill="none"/>'
    );
  }

  /* --------------- 筒子 --------------- */
  /** 同心圆点：外环 + 象牙内圈 + 圆心，形似雕刻筒面 */
  function dot(cx, cy, r, color, rings) {
    const dark = color === RED ? '#7d1f13' : (color === GREEN ? '#0b4a2e' : '#0f3f6b');
    let s = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + color + '" stroke="' + dark + '" stroke-width="0.6"/>';
    if (rings !== 1) {
      s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + (r * 0.62).toFixed(2) + '" fill="' + IVORY + '"/>';
      s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + (r * 0.3).toFixed(2) + '" fill="' + color + '"/>';
    } else {
      s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + (r * 0.3).toFixed(2) + '" fill="' + IVORY + '"/>';
    }
    return s;
  }

  function pinFace(i) {
    const r = i % 9; // 0..8
    let out = '';
    if (r === 0) {
      // 一筒：大号花心筒
      out =
        '<circle cx="22" cy="30" r="14.2" fill="' + RED + '" stroke="#7d1f13" stroke-width="0.8"/>' +
        '<circle cx="22" cy="30" r="11.4" fill="' + IVORY + '"/>' +
        '<circle cx="22" cy="30" r="9.2" fill="' + GREEN + '" stroke="#0b4a2e" stroke-width="0.7"/>' +
        '<circle cx="22" cy="30" r="6.2" fill="' + IVORY + '"/>' +
        '<circle cx="22" cy="30" r="3.6" fill="' + RED + '"/>' +
        '<circle cx="22" cy="30" r="1.2" fill="' + IVORY + '"/>';
    } else {
      const X = [12, 22, 32], Y = [17, 30, 43];
      const put = (gx, gy, rad, color) => { out += dot(X[gx], Y[gy], rad, color); };
      switch (r) {
        case 1: put(1, 0, 7.4, GREEN); put(1, 2, 7.4, GREEN); break;                  // 二筒
        case 2:                                                                       // 三筒 (斜)
          out += dot(10.5, 12.5, 6.8, BLUE) + dot(22, 30, 6.8, GREEN) + dot(33.5, 47.5, 6.8, BLUE);
          break;
        case 3: put(0, 0, 7.2, BLUE); put(2, 0, 7.2, GREEN); put(0, 2, 7.2, GREEN); put(2, 2, 7.2, BLUE); break; // 四筒
        case 4:                                                                       // 五筒
          out += dot(11.5, 14, 6.4, BLUE) + dot(32.5, 14, 6.4, GREEN) +
            dot(22, 30, 6.4, RED) + dot(11.5, 46, 6.4, GREEN) + dot(32.5, 46, 6.4, BLUE);
          break;
        case 5: put(0, 0, 6.8, GREEN); put(2, 0, 6.8, GREEN); put(0, 1, 6.8, GREEN); put(2, 1, 6.8, GREEN); put(0, 2, 6.8, GREEN); put(2, 2, 6.8, GREEN); break; // 六筒
        case 6:                                                                       // 七筒：上排三斜排 + 中下各二
          out += dot(11.8, 19.2, 5.4, GREEN) + dot(22, 14.6, 5.4, GREEN) + dot(32.2, 10, 5.4, GREEN) +
            dot(13.5, 32.5, 6, GREEN) + dot(30.5, 32.5, 6, GREEN) +
            dot(13.5, 47.5, 6, GREEN) + dot(30.5, 47.5, 6, GREEN);
          break;
        case 7:                                                                       // 八筒
          out += dot(13.5, 12, 5.4, BLUE) + dot(30.5, 12, 5.4, BLUE) +
            dot(13.5, 24.5, 5.4, BLUE) + dot(30.5, 24.5, 5.4, BLUE) +
            dot(13.5, 37, 5.4, BLUE) + dot(30.5, 37, 5.4, BLUE) +
            dot(13.5, 49.5, 5.4, BLUE) + dot(30.5, 49.5, 5.4, BLUE);
          break;
        case 8:                                                                       // 九筒
          for (let gy = 0; gy < 3; gy++) {
            const col = gy === 1 ? RED : GREEN;
            for (let gx = 0; gx < 3; gx++) out += dot(X[gx], Y[gy], 6.2, col);
          }
          break;
      }
    }
    return faceFrame(out);
  }

  /* --------------- 条子 --------------- */
  /** 竹节棍：圆角身 + 两道节痕 */
  function stick(cx, cy, h, color) {
    const w = 4.6, x = cx - w / 2, y = cy - h / 2;
    const dark = color === RED ? '#7d1f13' : '#0b4a2e';
    const lt = color === RED ? '#e9a695' : '#8ed3a8';
    let s = '<rect x="' + x.toFixed(2) + '" y="' + y.toFixed(2) + '" width="' + w + '" height="' + h.toFixed(2) + '" rx="2.2" fill="' + color + '" stroke="' + dark + '" stroke-width="0.5"/>';
    [0.32, 0.68].forEach(k => {
      const ly = (y + h * k).toFixed(2);
      s += '<line x1="' + (x + 0.9).toFixed(2) + '" y1="' + ly + '" x2="' + (x + w - 0.9).toFixed(2) + '" y2="' + ly + '" stroke="' + lt + '" stroke-width="0.7"/>';
    });
    s += '<rect x="' + (x + 0.7).toFixed(2) + '" y="' + (y + 1).toFixed(2) + '" width="1" height="' + (h - 2).toFixed(2) + '" fill="#ffffff" opacity=".25"/>';
    return s;
  }

  /** 一条：翠鸟 */
  function birdFace() {
    const D = '#0b4a2e';
    return faceFrame(
      '<path d="M8 49 C14 45.5 30 45.5 36 49" stroke="' + D + '" stroke-width="1.7" fill="none" stroke-linecap="round"/>' +
      '<path d="M24.5 30 C28.6 23 30.6 16 29.4 9.5 C26.4 14.6 24.6 21.5 23.4 27.5 Z" fill="' + RED + '"/>' +
      '<ellipse cx="20.6" cy="30.5" rx="7.6" ry="9.2" fill="' + GREEN + '"/>' +
      '<path d="M21 23.5 C15 25.5 12 31.5 13.2 39.5 C17.4 36 20.2 32.5 22.2 28 Z" fill="' + D + '"/>' +
      '<path d="M19.8 23.5 C19 19 20.2 14.6 22.2 11.4" stroke="' + GREEN + '" stroke-width="3.6" stroke-linecap="round"/>' +
      '<circle cx="22.6" cy="9.8" r="3.5" fill="' + GREEN + '"/>' +
      '<path d="M21.2 6.8 C20 3.4 22.4 2 24.4 3.6 C23.6 4.5 22.4 5.6 21.2 6.8 Z" fill="' + RED + '"/>' +
      '<path d="M25.8 9.3 L30 10.6 L26 12 Z" fill="' + RED + '"/>' +
      '<circle cx="23.6" cy="9" r="1" fill="' + IVORY + '"/>' +
      '<path d="M19.4 39.2 L18.4 46.2 M22.6 39.2 L24.2 45.6" stroke="' + RED + '" stroke-width="1.3" stroke-linecap="round"/>'
    );
  }

  function souFace(i) {
    const r = i % 9;
    if (r === 0) return birdFace();
    const X3 = [11.5, 22, 32.5];
    const X2 = [13.5, 30.5];
    let out = '';
    switch (r) {
      case 1: out += stick(22, 17.5, 17, GREEN) + stick(22, 42.5, 17, GREEN); break;            // 二条
      case 2: out += stick(22, 13, 13, GREEN) + stick(22, 30, 13, GREEN) + stick(22, 47, 13, GREEN); break; // 三条
      case 3:                                                                                   // 四条
        out += stick(X2[0], 17.5, 17, GREEN) + stick(X2[1], 17.5, 17, GREEN) +
          stick(X2[0], 42.5, 17, GREEN) + stick(X2[1], 42.5, 17, GREEN);
        break;
      case 4:                                                                                   // 五条
        out += stick(X2[0], 16, 15, GREEN) + stick(X2[1], 16, 15, GREEN) + stick(22, 30, 15, RED) +
          stick(X2[0], 44, 15, GREEN) + stick(X2[1], 44, 15, GREEN);
        break;
      case 5:                                                                                   // 六条
        out += stick(X2[0], 13, 12.5, GREEN) + stick(X2[1], 13, 12.5, GREEN) +
          stick(X2[0], 30, 12.5, GREEN) + stick(X2[1], 30, 12.5, GREEN) +
          stick(X2[0], 47, 12.5, GREEN) + stick(X2[1], 47, 12.5, GREEN);
        break;
      case 6:                                                                                   // 七条
        out += stick(22, 12, 11, RED) +
          stick(X2[0], 27.5, 11.5, GREEN) + stick(X2[1], 27.5, 11.5, GREEN) +
          stick(X2[0], 41, 11.5, GREEN) + stick(X2[1], 41, 11.5, GREEN) +
          stick(X2[0], 54.5, 11.5, GREEN) + stick(X2[1], 54.5, 11.5, GREEN);
        break;
      case 7:                                                                                   // 八条
        out += stick(X2[0], 12.5, 10.5, GREEN) + stick(X2[1], 12.5, 10.5, GREEN) +
          stick(X2[0], 25, 10.5, GREEN) + stick(X2[1], 25, 10.5, GREEN) +
          stick(X2[0], 37.5, 10.5, GREEN) + stick(X2[1], 37.5, 10.5, GREEN) +
          stick(X2[0], 50, 10.5, GREEN) + stick(X2[1], 50, 10.5, GREEN);
        break;
      case 8:                                                                                   // 九条
        for (let gy = 0; gy < 3; gy++) {
          const col = gy === 1 ? RED : GREEN;
          for (let gx = 0; gx < 3; gx++) out += stick(X3[gx], 15 + gy * 15, 13, col);
        }
        break;
    }
    return faceFrame(out);
  }

  /* --------------- 字牌 --------------- */
  function honorFace(i) {
    const ch = HONOR_NAMES[i - 27];
    if (i === 33) {
      // 白：空框
      return faceFrame(
        '<rect x="11" y="9" width="22" height="42" rx="3.4" fill="none" stroke="' + BLUE + '" stroke-width="2" stroke-dasharray="4,2"/>' +
        '<rect x="15" y="13" width="14" height="34" rx="2.2" fill="none" stroke="' + BLUE + '" stroke-width="1" stroke-opacity=".6"/>'
      );
    }
    const color = i === 31 ? RED : (i === 32 ? GREEN : INK);
    const size = i >= 31 ? 26 : 25;
    return faceFrame(glyph(ch, { y: i >= 31 ? 40 : 39.5, size: size, color: color, stroke: 0.9 }));
  }

  /* --------------- 牌背 --------------- */
  function backInner() {
    return (
      '<rect x="1" y="1" width="' + (VW - 2) + '" height="' + (VH - 2) + '" rx="6" fill="url(#mjBack)"/>' +
      '<rect x="1" y="1" width="' + (VW - 2) + '" height="' + (VH - 2) + '" rx="6" fill="url(#mjBackBevel)"/>' +
      '<rect x="1" y="1" width="' + (VW - 2) + '" height="' + (VH - 2) + '" rx="6" fill="none" stroke="#d8b273" stroke-width="0.8"/>' +
      '<rect x="5" y="5" width="' + (VW - 10) + '" height="' + (VH - 10) + '" rx="3.4" fill="none" stroke="#e6c785" stroke-opacity=".5" stroke-width="0.8"/>' +
      '<path d="M22 18 L30 30 L22 42 L14 30 Z" fill="none" stroke="#e6c785" stroke-width="1.2" stroke-opacity=".75"/>' +
      '<path d="M22 24 L26.2 30 L22 36 L17.8 30 Z" fill="#e6c785" fill-opacity=".34"/>' +
      '<path d="M7 3.6 H' + (VW - 7) + '" stroke="#ffd9a0" stroke-opacity=".45" stroke-width="1" stroke-linecap="round"/>'
    );
  }

  function backFace(variant) {
    if (variant === 'side') {
      return (
        '<svg viewBox="0 0 ' + VH + ' ' + VW + '" xmlns="http://www.w3.org/2000/svg" class="tile-svg" preserveAspectRatio="none">' +
        defs() +
        '<g transform="translate(' + VH + ' 0) rotate(90)">' + backInner() + '</g>' +
        '</svg>'
      );
    }
    return (
      '<svg viewBox="0 0 ' + VW + ' ' + VH + '" xmlns="http://www.w3.org/2000/svg" class="tile-svg" preserveAspectRatio="none">' +
      defs() + backInner() + '</svg>'
    );
  }

  const faceCache = {};
  function tileFaceSVG(i) {
    if (!faceCache[i]) {
      if (i < 9) faceCache[i] = manFace(i);
      else if (i < 18) faceCache[i] = pinFace(i);
      else if (i < 27) faceCache[i] = souFace(i);
      else faceCache[i] = honorFace(i);
    }
    return faceCache[i];
  }

  /* --------------- 合成音效 --------------- */
  class Sound {
    constructor() {
      this.ctx = null;
      this.muted = false;
      this.volume = 1;
      this._voice = undefined;
      this._voiceHooked = false;
    }
    ensure() {
      if (!this.ctx) {
        const AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext);
        if (!AC) return false;
        this.ctx = new AC();
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return true;
    }
    _noise(dur, freq, q, gain, type, delay) {
      if (this.muted || !this.ensure()) return;
      const ctx = this.ctx;
      const t0 = ctx.currentTime + (delay || 0);
      const n = Math.floor(ctx.sampleRate * dur);
      const buf = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const f = ctx.createBiquadFilter();
      f.type = type || 'bandpass';
      f.frequency.value = freq;
      f.Q.value = q || 1.2;
      const g = ctx.createGain();
      g.gain.setValueAtTime(gain * this.volume, t0);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      src.connect(f); f.connect(g); g.connect(ctx.destination);
      src.start(t0);
    }
    _tone(freq, dur, gain, delay, type) {
      if (this.muted || !this.ensure()) return;
      const ctx = this.ctx;
      const t = ctx.currentTime + (delay || 0);
      const o = ctx.createOscillator();
      o.type = type || 'sine';
      o.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain * this.volume), t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(ctx.destination);
      o.start(t); o.stop(t + dur + 0.05);
    }
    clack() { this._noise(0.07, 2400, 1.5, 0.5); }

    pickFemaleVoice() {
      if (this._voice !== undefined) return this._voice;
      const SS = (typeof window !== 'undefined') && window.speechSynthesis;
      if (!SS || typeof SS.getVoices !== 'function') { this._voice = null; return null; }
      let vs = [];
      try { vs = SS.getVoices() || []; } catch (e) { vs = []; }
      if (!vs.length) {
        if (!this._voiceHooked) {
          this._voiceHooked = true;
          try { SS.addEventListener('voiceschanged', () => { this._voice = undefined; this.pickFemaleVoice(); }); } catch (e) {}
        }
        this._voice = null;
        return null;
      }
      const zh = vs.filter(v => /^(zh|cmn)/i.test(v.lang || ''));
      const pool = zh.length ? zh : vs;
      const FEMALE = /xiaoxiao|xiaoyi|xiaomo|xiaoxuan|xiaorui|xiaohan|huihui|yaoyao|ting-?ting|mei-?jia|sinji|female|woman|girl/i;
      const MALE = /yunxi|yunjian|yunyang|yunjie|kangkang|liang|male|男/i;
      this._voice = pool.find(v => FEMALE.test(v.name || ''))
        || pool.find(v => !MALE.test(v.name || '') && /zh|cmn/i.test(v.lang || ''))
        || pool.find(v => !MALE.test(v.name || ''))
        || pool[0] || null;
      return this._voice;
    }

    speak(text, opts = {}) {
      if (this.muted || !text) return false;
      const SS = (typeof window !== 'undefined') && window.speechSynthesis;
      const Utter = (typeof window !== 'undefined') && window.SpeechSynthesisUtterance;
      if (!SS || !Utter) return false;
      try {
        const u = new Utter(text);
        u.lang = 'zh-CN';
        u.rate = opts.rate === undefined ? 1.15 : opts.rate;
        u.pitch = opts.pitch === undefined ? 1.45 : opts.pitch;
        u.volume = Math.min(1, (opts.volume === undefined ? 1 : opts.volume) * this.volume);
        const v = this.pickFemaleVoice();
        if (v) u.voice = v;
        const fire = () => { try { SS.cancel(); SS.speak(u); } catch (e) { /* ignore */ } };
        if (opts.delay) {
          setTimeout(fire, Math.round(opts.delay * 1000));
          return true;
        }
        fire();
        return true;
      } catch (e) {
        return false;
      }
    }

    thud() { this._noise(0.1, 420, 1, 0.6); this._tone(150, 0.1, 0.15); }
    tick() { this._noise(0.04, 3200, 2, 0.25); }
    deal() {
      [0, 1, 2, 3].forEach(i => this._noise(0.055, 2100 + i * 260, 1.6, 0.3, 'bandpass', i * 0.075));
      this._tone(880, 0.12, 0.06, 0.22, 'triangle');
    }
    chi() {
      this._noise(0.045, 2700, 1.7, 0.42);
      this._tone(783.99, 0.13, 0.1, 0.01, 'triangle');
      this._tone(1174.66, 0.2, 0.09, 0.075, 'triangle');
      this.speak('吃', { pitch: 1.5, rate: 1.18 });
    }
    pong() {
      this._noise(0.05, 1900, 1.1, 0.5);
      this._noise(0.075, 1150, 0.9, 0.42, 'bandpass', 0.045);
      this._tone(196, 0.24, 0.16, 0, 'sine');
      this._tone(392, 0.18, 0.1, 0.05, 'triangle');
      this.speak('碰', { pitch: 1.34, rate: 1.12 });
    }
    kong() {
      this._noise(0.09, 1500, 0.9, 0.55);
      this._noise(0.12, 640, 0.8, 0.5, 'bandpass', 0.06);
      this._tone(261.63, 0.3, 0.15, 0, 'sine');
      this._tone(392, 0.24, 0.1, 0.06, 'triangle');
      this.speak('杠', { pitch: 1.25, rate: 1.1 });
    }
    win() {
      [523.25, 659.25, 783.99, 1046.5, 1318.51].forEach((f, i) => this._tone(f, 0.55, 0.11, i * 0.08, 'sine'));
      this._tone(1567.98, 0.7, 0.07, 0.42, 'triangle');
      this._noise(0.35, 5600, 0.8, 0.14, 'highpass', 0.02);
      this.speak('胡了', { pitch: 1.42, rate: 1.0, volume: 1.1 });
    }
    chime() {
      [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this._tone(f, 0.5, 0.1, i * 0.09));
    }
    fail() { this._tone(220, 0.18, 0.08, 0, 'triangle'); this._tone(180, 0.22, 0.08, 0.12, 'triangle'); }
  }

  return {
    indexToTile, tileToIndex, tileName, SUIT_OF, RANK_OF, isHonor, isTerminal,
    TOTAL_KINDS, SUIT_CHARS, HONOR_NAMES, CN_NUM,
    tileFaceSVG, backFace, Sound,
    COLORS: { INK, RED, GREEN, BLUE, IVORY, GOLD, GOLD_LT },
  };
});
