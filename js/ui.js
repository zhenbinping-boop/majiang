/**
 * ui.js - 界面渲染、动画、交互与弹窗
 * 依赖全局 MJ (牌面 SVG/音效)、MJEngine (赔率表/金币) 与 controller (对局控制器)
 */
(function (global) {
  'use strict';
  const MJ = global.MJ;

  const SEAT_INFO = [
    { name: '你', avatar: '我', color: '#e9c063' },
    { name: '小龙', avatar: '龙', color: '#7fb8e8' },
    { name: '阿秀', avatar: '秀', color: '#e8897a' },
    { name: '老陈', avatar: '陈', color: '#86d99a' },
  ];
  const WIND_NAMES = ['东', '南', '西', '北'];
  const SEAT_DOM = { 1: 'seat-1', 2: 'seat-2', 3: 'seat-3' };
  const delay = (ms) => new Promise(r => setTimeout(r, ms));

  /** 千分位金币：5000 -> 5,000 */
  function fmtCoins(n) {
    const v = Math.round(n) || 0;
    const s = String(Math.abs(v));
    return (v < 0 ? '-' : '') + s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  /** 席位面板紧凑写法：500000 -> 50万 */
  function coinShort(n) {
    const v = Math.round(n) || 0;
    if (Math.abs(v) < 100000) return fmtCoins(v);
    const w = v / 10000;
    return (Math.abs(w - Math.round(w)) < 0.05 ? Math.round(w).toString() : w.toFixed(1)) + '万';
  }

  function removeOne(tiles, t) {
    const a = tiles.slice();
    const i = a.indexOf(t);
    if (i >= 0) a.splice(i, 1);
    return a;
  }

  class UI {
    constructor(controller) {
      this.ctrl = controller;
      this.engine = controller.engine;
      this.sound = new MJ.Sound();
      this.selectedTile = null;
      this.selectedIdx = -1;
      this.freshTile = null;      // 刚摸到的那张（用于金色高亮，不随重渲染重复播放动画）
      this.handClickResolve = null;
      this.actionResolve = null;
      this.actionTimer = null;
      this.riverCount = 0;
      this._tingMap = new Map();  // Map<discardTile, { total, live: { [winTile]: count } }>
      this.$ = (id) => document.getElementById(id);
      this._bindKeyboard();
      this._mountTable3D();
    }

    /**
     * 挂载 Three.js 3D 牌桌（可用时）。
     * 3D 模式下手牌/牌河/副露/立牌全部在 WebGL 场景渲染，DOM 只留 HUD；
     * 不可用（无 WebGL / ?ui=dom）时保持原有平面 DOM 渲染，行为不变。
     * 统一暴露 window.__mjTable3d 调试接口（两条路径同形），供测试驱动。
     */
    _mountTable3D() {
      this.t3d = null;
      const forceDom = typeof location !== 'undefined' && /[?&]ui=dom/.test(location.search);
      const table = this.$('table');
      if (!forceDom && table && global.MJTable3D && global.MJTable3D.isSupported()) {
        this.t3d = global.MJTable3D.mount(table, MJ, {
          canPick: () => !!this.handClickResolve,
        });
      }
      if (this.t3d) {
        table.classList.add('t3d');
        this.t3d.onPickTile = (idx, tIdx) => this.onHandTileClick(tIdx, null, idx);
        this.t3d.onHoverTile = (idx, tIdx) => {
          if (idx === null) {
            if (this.selectedTile === null) {
              this.highlightSameTiles(null);
              this.refreshPassiveTingTip();
            }
          } else {
            this.highlightSameTiles(tIdx);
            const u = this._tingMap && this._tingMap.get(tIdx);
            if (u) this.showTingTip(u, `打 ${MJ.tileName(tIdx)} 听`);
            else this.hideTingTip();
          }
        };
      }
      const self = this;
      global.__mjTable3d = {
        get is3D() { return !!self.t3d; },
        canvasPresent() { return !!document.getElementById('table-3d'); },
        clickHandTile(i) {
          const p = self.engine.players[0];
          if (!p || i < 0 || i >= p.hand.length) return false;
          if (self.t3d) return self.t3d.debug().clickHandTile(i);
          const box = self.$('my-hand');
          const el = box && box.querySelectorAll('.tile')[i];
          if (!el) return false;
          el.click();
          return true;
        },
        hoverHandTile(i) {
          const p = self.engine.players[0];
          if (!p || i < 0 || i >= p.hand.length) return false;
          if (self.t3d) return self.t3d.debug().hoverHandTile(i);
          const box = self.$('my-hand');
          const el = box && box.querySelectorAll('.tile')[i];
          if (!el) return false;
          el.dispatchEvent(new Event('mouseenter'));
          return true;
        },
        unhover() {
          if (self.t3d) self.t3d.debug().unhover();
        },
        tileMeshCount() { return self.t3d ? self.t3d.debug().tileMeshCount() : -1; },
        handCount(pid) { return self.engine.players[pid].hand.length; },
        riverCount(pid) { return self.engine.players[pid].discards.length; },
        meldCount(pid) { return self.engine.players[pid].melds.length; },
        /** 3D 出牌飞行中尚未落桌的数量（DOM 模式恒 0）；测试用它等待动画收敛 */
        pendingCount() { return self.t3d ? (self.t3d.debug().pendingCount ? self.t3d.debug().pendingCount() : 0) : 0; },
      };
    }

    /** 绑定键盘快捷操作：左右方向键选牌、Enter/Space 出牌、Esc 关闭规则弹窗 */
    _bindKeyboard() {
      if (typeof document === 'undefined' || !document.addEventListener) return;
      document.addEventListener('keydown', (e) => {
        if (!e) return;
        if (e.key === 'Escape') {
          const root = this.$('modal-root');
          if (root && root.firstChild && this._modalClosable) {
            this.sound.tick();
            this.closeModal();
          }
          return;
        }
        if (!this.handClickResolve) return;
        const p = this.engine.players[0];
        if (!p || !p.hand.length) return;
        const box = this.$('my-hand');
        let els = box && box.querySelectorAll ? [...box.querySelectorAll('.tile')] : [];
        if (!els.length && this.t3d) els = p.hand;   // 3D 模式：虚拟列表驱动键盘选牌
        if (!els.length) return;
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          const dir = e.key === 'ArrowRight' ? 1 : -1;
          const nextIdx = this.selectedIdx < 0
            ? (dir > 0 ? 0 : els.length - 1)
            : (this.selectedIdx + dir + els.length) % els.length;
          this.selectHandTileAt(nextIdx, p.hand[nextIdx], els[nextIdx]);
        } else if ((e.key === 'Enter' || e.key === ' ') && this.selectedTile !== null) {
          e.preventDefault();
          this.resolveHandDiscard(this.selectedTile);
        }
      });
    }

    /** 清理挂起中的交互 Promise 与定时器（供重新开局安全重置） */
    cancelPendingInteractions() {
      this.clearActionTimer();
      this.handClickResolve = null;
      this.actionResolve = null;
      this.selectedTile = null;
      this.selectedIdx = -1;
      if (this.t3d) { this.t3d.setSelected(-1); this.t3d.setHover(-1); }
      this.highlightSameTiles(null);
      this.hideTingTip();
    }

    /* =============== 基础元素 =============== */
    tileEl(t, opts = {}) {
      const d = document.createElement('div');
      d.className = 'tile' + (opts.small ? ' sm' : '') + (opts.cls ? ' ' + opts.cls : '');
      d.innerHTML = opts.back ? MJ.backFace(opts.orient || '') : MJ.tileFaceSVG(t);
      if (!opts.back) d.dataset.tile = String(t);
      return d;
    }
    el(tag, cls, html) {
      const d = document.createElement(tag);
      if (cls) d.className = cls;
      if (html !== undefined) d.innerHTML = html;
      return d;
    }

    /* =============== 听牌计算与桌面联动高亮 =============== */

    /** 计算当前我的手牌若打出某张后可听哪些牌（Map<tile, { total, live }>） */
    computeMyTingMap() {
      const map = new Map();
      const p = this.engine.players[0];
      if (!p || !this.ctrl || !this.ctrl.ai) return map;
      const meldCount = p.melds.length;
      if (p.hand.length !== 14 - meldCount * 3) return map;
      const visible = this.ctrl.ai.visibleCounts(p);
      const seen = new Set();
      for (const t of p.hand) {
        if (seen.has(t)) continue;
        seen.add(t);
        const rest = removeOne(p.hand, t);
        const uke = this.ctrl.ai.liveUkeire(rest, meldCount, visible);
        if (uke.shanten === 0) {
          map.set(t, uke);
        }
      }
      return map;
    }

    /** 高亮牌河与副露中与指定牌相同的牌面 */
    highlightSameTiles(tileIdx) {
      if (this.t3d) { this.t3d.highlightSame(tileIdx === null || tileIdx === undefined ? null : tileIdx); return; }
      const table = this.$('table');
      if (!table || !table.querySelectorAll) return;
      const all = table.querySelectorAll('.tile');
      const target = tileIdx === null || tileIdx === undefined ? null : String(tileIdx);
      for (const el of all) {
        if (target !== null && el.dataset && el.dataset.tile === target) {
          el.classList.add('same-match');
        } else {
          el.classList.remove('same-match');
        }
      }
    }

    /** 展示听牌提示条（显示打该牌后可胡的牌面与剩余张数） */
    showTingTip(uke, prefixText) {
      const panel = this.$('me-panel');
      if (!panel) return;
      let tip = this.$('ting-tip');
      if (!tip) {
        tip = this.el('div', 'ting-tip hidden');
        tip.id = 'ting-tip';
        const me = this.$('me');
        if (me && me.insertBefore) me.insertBefore(tip, panel);
      }
      const entries = Object.keys(uke.live || {}).map(k => ({ tile: +k, left: uke.live[k] }));
      if (!entries.length) {
        tip.innerHTML = `<span class="ting-label">${prefixText || '听牌'}</span><span class="ting-empty">所听之牌已全部现出 (0 张)</span>`;
      } else {
        const items = entries.map(e =>
          `<span class="ting-item"><span class="ting-svg">${MJ.tileFaceSVG(e.tile)}</span><span class="ting-cnt">${e.left}张</span></span>`
        ).join('');
        tip.innerHTML = `<span class="ting-label">${prefixText || '听'} · 共 ${uke.total} 张</span><div class="ting-list">${items}</div>`;
      }
      tip.classList.remove('hidden');
    }

    hideTingTip() {
      const tip = this.$('ting-tip');
      if (tip) tip.classList.add('hidden');
    }

    /** 非出牌阶段若已处于听牌状态，则在状态栏旁展示当前所听之牌 */
    refreshPassiveTingTip() {
      const p = this.engine.players[0];
      if (!p || !this.ctrl || !this.ctrl.ai) return;
      if (p.hand.length === 13 - p.melds.length * 3 && this.engine.isTenpai(p)) {
        const visible = this.ctrl.ai.visibleCounts(p);
        const uke = this.ctrl.ai.liveUkeire(p.hand, p.melds.length, visible);
        this.showTingTip(uke, '当前听牌');
      } else {
        this.hideTingTip();
      }
    }

    /* =============== 整手渲染 =============== */
    renderAll() {
      this.renderTopbar();
      this.renderMySeat();
      for (let pid = 1; pid <= 3; pid++) this.renderAISeat(pid);
      this.renderRivers();
      this.setTurn(this.engine.turn);
    }

    renderTopbar() {
      this.$('round-name').textContent = this.engine.roundName;
      const left = this.engine.wall.length + this.engine.dead.length;
      this.$('wall-count').textContent = '牌山 ' + left;
      // 中央铭牌：场风 + 局数 + 余张 + 四家座风
      const wind = ['东', '南'][this.engine.prevailingWind] || '东';
      const cw = this.$('cp-wind'); if (cw) cw.textContent = wind;
      const cr = this.$('cp-round'); if (cr) cr.textContent = this.engine.roundName;
      const cwl = this.$('cp-wall'); if (cwl) cwl.textContent = '余 ' + left + ' 张';
      // 3D 罗盘同步：局数 / 余牌 / 四家座风（罗盘 CanvasTexture 平面绘制，不重叠）
      if (this.t3d && this.t3d.setCompassInfo) {
        this.t3d.setCompassInfo(
          this.engine.roundName, '余 ' + left + ' 张',
          this.engine.players.map((p) => WIND_NAMES[p.wind]));
      }
      for (let pid = 0; pid < 4; pid++) {
        const m = this.$('cpm-' + pid);
        if (m) m.textContent = WIND_NAMES[this.engine.players[pid].wind];
      }
    }

    badge(text, cls) { return `<span class="badge ${cls || ''}">${text}</span>`; }

    seatInfoHTML(p) {
      const s = SEAT_INFO[p.id];
      const wind = WIND_NAMES[p.wind];
      let meta = this.badge(wind + '风', 'wind') + (p.dealer ? this.badge('庄', 'dealer') : '');
      if (p.id === 0 && this.engine.isTenpai(p)) meta += this.badge('听', 'tenpai');
      return `
        <div class="seat-info">
          <div class="avatar" style="background:${s.color}">${s.avatar}</div>
          <div class="seat-text">
            <span class="seat-name">${s.name}</span>
            <span class="seat-meta"><span class="seat-score">${coinShort(p.score)}</span>${meta}</span>
          </div>
        </div>`;
    }

    /**
     * 副露 (吃 / 碰 / 杠)：摆在该玩家身旁。
     * 被鸣的那张 (来自他家弃牌) 加金框标记，一眼看清是从谁那里吃碰来的。
     */
    meldEl(m, small) {
      const g = this.el('div', 'meld');
      let marked = false;
      m.tiles.forEach(t => {
        const claimed = !marked && m.from >= 0 && t === m.tile;
        if (claimed) marked = true;
        g.appendChild(this.tileEl(t, { small, cls: claimed ? 'claimed' : '' }));
      });
      return g;
    }

    renderMySeat() {
      const p = this.engine.players[0];
      this.$('me-info').innerHTML = this.seatInfoHTML(p);
      if (this.t3d) {
        // 先 syncHand（更新 _handInfo）再 syncMelds —— 副露排版依赖最新手牌宽度
        this.renderMyHand();
        this.t3d.syncMelds(0, p.melds);
        return;
      }
      const meldsBox = this.$('my-melds');
      meldsBox.innerHTML = '';
      p.melds.forEach(m => meldsBox.appendChild(this.meldEl(m, true)));
      this.renderMyHand();
    }

    /**
     * 渲染手牌
     * @param {Object} opts { animate: 逐张进场, freshAnimate: 最新摸到的牌播放位移入场 }
     * 规则：只有真正新摸到的牌带一次性入场动画；`last-drawn` 只做静态金环，
     *       因此后续任何一次重渲染都不会再触发位移，彻底消除“整手牌抖动”。
     */
    renderMyHand(opts = {}) {
      const p = this.engine.players[0];
      this._tingMap = this.computeMyTingMap();
      if (this.t3d) {
        let freshIdx = -1;
        if (this.freshTile !== null && this.freshTile !== undefined) {
          for (let i = p.hand.length - 1; i >= 0; i--) if (p.hand[i] === this.freshTile) { freshIdx = i; break; }
        }
        this.t3d.syncHand(0, p.hand, {
          animate: !!opts.animate,
          freshIdx,
        });
        this.selectedTile = null;
        this.selectedIdx = -1;
        this.t3d.setSelected(-1);
        this.highlightSameTiles(null);
        this.refreshPassiveTingTip();
        return;
      }
      const box = this.$('my-hand');
      box.innerHTML = '';
      let freshIdx = -1;
      if (this.freshTile !== null && this.freshTile !== undefined) {
        for (let i = p.hand.length - 1; i >= 0; i--) if (p.hand[i] === this.freshTile) { freshIdx = i; break; }
      }
      p.hand.forEach((t, i) => {
        const canTing = this._tingMap.has(t);
        const el = this.tileEl(t, { cls: 'playable' + (canTing ? ' can-ting' : '') });
        if (opts.animate) {
          el.style.animation = 'deal-in .32s both';
          el.style.animationDelay = (i * 0.035).toFixed(3) + 's';
        }
        if (i === freshIdx) {
          el.classList.add('last-drawn');
          if (opts.freshAnimate) el.classList.add('just-drawn');
        }
        el.addEventListener('click', () => this.onHandTileClick(t, el, i));
        el.addEventListener('dblclick', () => this.resolveHandDiscard(t));
        el.addEventListener('mouseenter', () => {
          if (this.selectedTile === null) {
            this.highlightSameTiles(t);
            if (canTing) this.showTingTip(this._tingMap.get(t), `打 ${MJ.tileName(t)} 听`);
          }
        });
        el.addEventListener('mouseleave', () => {
          if (this.selectedTile === null) {
            this.highlightSameTiles(null);
            this.refreshPassiveTingTip();
          }
        });
        box.appendChild(el);
      });
      this.selectedTile = null;
      this.selectedIdx = -1;
      this.highlightSameTiles(null);
      this.refreshPassiveTingTip();
    }

    renderAISeat(pid) {
      const p = this.engine.players[pid];
      const box = this.$(SEAT_DOM[pid]);
      const isTop = pid === 2;
      const panel = this.el('div', 'panel');
      panel.id = 'panel-' + pid;
      if (this.engine.turn === pid) panel.classList.add('active');

      const info = this.el('div');
      info.innerHTML = this.seatInfoHTML(p);

      panel.appendChild(info);

      if (this.t3d) {
        // 3D 模式：立牌与副露在 WebGL 场景渲染，DOM 面板只留信息胶囊
        this.t3d.syncHand(pid, p.hand);
        this.t3d.syncMelds(pid, p.melds);
        box.innerHTML = '';
        box.appendChild(panel);
        return;
      }

      // 牌墙：对家横排、左右家竖排 (牌背横置，模拟桌沿视角)
      const backs = this.el('div', 'seat-backs ' + (isTop ? 'h' : 'v'));
      for (let i = 0; i < p.hand.length; i++) backs.appendChild(this.tileEl(0, { back: true, orient: isTop ? '' : 'side' }));

      // 副露摆在手牌与桌心之间，形成“自身 - 手牌 - 副露 - 牌河”的空间顺序
      const melds = this.el('div', isTop ? 'melds' : 'side-melds');
      p.melds.forEach(m => melds.appendChild(this.meldEl(m, true)));

      panel.appendChild(backs);
      if (p.melds.length) panel.appendChild(melds);

      box.innerHTML = '';
      box.appendChild(panel);
    }

    /**
     * 四家各自的出牌区：每家正前方一块，互不混放。
     * 全桌最新一张弃牌带悬浮光标；只有新落的牌播放入场动画 (重渲染不重播)。
     */
    renderRivers(opts = {}) {
      const seen = this._riverSeen || (this._riverSeen = [0, 0, 0, 0]);
      const cursorPid = (this.engine.lastDiscarder !== null && this.engine.lastDiscarder >= 0)
        ? this.engine.lastDiscarder : -1;

      if (this.t3d) {
        const discards = [0, 1, 2, 3].map((pid) => this.engine.players[pid].discards);
        this.t3d.syncRivers(discards, cursorPid, { animateNew: opts.animate !== false });
        for (let pid = 0; pid < 4; pid++) seen[pid] = discards[pid].length;
        return;
      }

      for (let pid = 0; pid < 4; pid++) {
        const box = this.$('river-' + pid);
        if (!box) continue;
        const tiles = this.engine.players[pid].discards;
        box.innerHTML = '';
        tiles.forEach((t, i) => {
          const el = this.tileEl(t, { small: true });
          if (opts.animate !== false && i >= seen[pid]) el.classList.add('drop-in');
          if (pid === cursorPid && i === tiles.length - 1) el.classList.add('cursor');
          box.appendChild(el);
        });
        seen[pid] = tiles.length;
      }
    }

    setTurn(pid) {
      for (let i = 1; i <= 3; i++) {
        const panel = this.$('panel-' + i);
        if (panel) panel.classList.toggle('active', i === pid);
      }
      // 中央铭牌上高亮当前行动家 (座风字点亮)
      for (let i = 0; i < 4; i++) {
        const m = this.$('cpm-' + i);
        if (m) m.classList.toggle('hot', i === pid);
      }
      if (this.t3d) this.t3d.setTurn(pid);
      const s = SEAT_INFO[pid];
      this.$('turn-banner').textContent = pid === 0 ? '轮到你出牌' : `轮到 ${s.name} 出牌`;
    }

    /* =============== 浮字 (吃 / 碰 / 杠 / 胡) =============== */
    flash(text, kind) {
      const el = this.$('action-flash');
      if (!el) return;
      el.textContent = text;
      el.className = 'k-' + kind;
      void el.offsetWidth;          // 强制重排，保证动画可重复触发
      el.classList.add('show');
      clearTimeout(this._flashTimer);
      this._flashTimer = setTimeout(() => el.classList.remove('show'), 960);
    }

    /* =============== 动画 =============== */
    /** 发牌：全量渲染一次，随后手牌逐张轻落 (无缩放、无回弹)，不再二次重渲染造成跳动 */
    async animateDeal() {
      this.freshTile = null;
      this.riverCount = 0;
      this._riverSeen = [0, 0, 0, 0];
      if (this.t3d) this.t3d.resetForDeal();
      this.renderAll();
      this.renderRivers({ animate: false });
      this.renderMyHand({ animate: true });
      this.sound.deal();
      await delay(640);
    }

    /** 摸牌：仅最新一张做一次干净的位移入场 + 金环高亮 */
    async animateDraw(pid, tile) {
      if (pid === 0) {
        this.freshTile = tile;
        this.renderMySeat();
        this.renderMyHand({ freshAnimate: true });
      } else {
        this.renderAISeat(pid);
      }
      if (this.t3d) this.t3d.playDraw(pid);
      this.sound.clack();
      await delay(200);
    }

    animateDiscard(pid, tile) {
      if (pid === 0) this.freshTile = null;
      this.renderTopbar();
      if (this.t3d) {
        // 3D：牌河最后一张暂扣，由 3D 手部拍落后揭示 + 冲击波
        if (pid === 0) this.renderMySeat(); else this.renderAISeat(pid);
        const discards = [0, 1, 2, 3].map((p) => this.engine.players[p].discards);
        const cursorPid = (this.engine.lastDiscarder !== null && this.engine.lastDiscarder >= 0)
          ? this.engine.lastDiscarder : -1;
        this.t3d.syncRivers(discards, cursorPid, { pendingPid: pid });
        this.t3d.playDiscard(pid, discards, cursorPid);
        this.sound.clack();
        return;
      }
      this.renderRivers();
      if (pid === 0) this.renderMySeat();
      else this.renderAISeat(pid);
      this.sound.clack();
    }

    /** 鸣牌：音效 (合成撞击 + 女声喊牌) 与浮字同步动作 */
    async animateClaim(pid, kind) {
      const text = { chi: '吃', pong: '碰', kong: '杠' }[kind] || '碰';
      if (kind === 'chi') this.sound.chi();
      else if (kind === 'pong') this.sound.pong();
      else this.sound.kong();
      this.flash(text, kind);
      if (pid === 0) this.renderMySeat(); else this.renderAISeat(pid);
      if (this.t3d) this.t3d.playClaim(pid);
      await delay(430);
    }

    /* =============== 交互：我的出牌 =============== */
    selectHandTileAt(idx, t, el) {
      const box = this.$('my-hand');
      if (box && box.querySelectorAll) {
        box.querySelectorAll('.tile.selected').forEach(e => e.classList.remove('selected'));
      }
      if (el) el.classList.add('selected');
      this.selectedTile = t;
      this.selectedIdx = idx;
      if (this.t3d) this.t3d.setSelected(idx);
      this.highlightSameTiles(t);
      if (this._tingMap && this._tingMap.has(t)) {
        this.showTingTip(this._tingMap.get(t), `打 ${MJ.tileName(t)} 听`);
      } else {
        this.hideTingTip();
      }
    }

    onHandTileClick(t, el, idx = -1) {
      if (!this.handClickResolve) return; // 非本人回合忽略点击
      this.sound.tick();
      if (this.selectedTile === t) {
        this.resolveHandDiscard(t);
        return;
      }
      this.selectHandTileAt(idx, t, el);
    }

    resolveHandDiscard(t) {
      if (!this.handClickResolve) return;
      const resolve = this.handClickResolve;
      this.handClickResolve = null;
      this.selectedTile = null;
      this.selectedIdx = -1;
      this.highlightSameTiles(null);
      resolve(t);
    }

    /** 等待玩家点击手牌弃牌 */
    askDiscard() {
      const hasTingMove = this._tingMap && this._tingMap.size > 0;
      this.showHint(hasTingMove ? '点击手牌出牌 · 标「听」之牌打出即听牌' : '点击手牌出牌 (双击快速出牌)');
      return new Promise(resolve => { this.handClickResolve = resolve; });
    }

    /* =============== 操作栏 =============== */
    showHint(text) {
      this.$('turn-banner').textContent = text;
    }

    showActions(buttons, timeoutSec) {
      const bar = this.$('action-bar');
      bar.innerHTML = '';
      let remain = timeoutSec || 0;
      const countEl = remain ? this.el('span', 'act-count', remain + 's') : null;
      buttons.forEach(b => {
        const btn = this.el('button', 'act-btn ' + (b.cls || ''));
        btn.type = 'button';
        btn.innerHTML = b.label + (b.sub ? `<span class="sub">${b.sub}</span>` : '');
        btn.addEventListener('click', () => {
          this.sound.tick();
          this.clearActionTimer();
          this.hideActions();
          if (this.actionResolve) {
            const r = this.actionResolve;
            this.actionResolve = null;
            r(b.value);
          }
        });
        bar.appendChild(btn);
      });
      if (remain) {
        const first = bar.querySelector('.act-btn');
        if (first && countEl) first.appendChild(countEl);
        this.actionTimer = setInterval(() => {
          remain--;
          if (countEl) countEl.textContent = remain + 's';
          if (remain <= 0) {
            this.clearActionTimer();
            this.hideActions();
            if (this.actionResolve) {
              const r = this.actionResolve;
              this.actionResolve = null;
              r(null);
            }
            this.toast('超时，自动跳过');
          }
        }, 1000);
      }
      bar.classList.remove('hidden');
      // 操作栏入位 → 听牌浮窗上移让位（中央黄金带垂直错位分层）
      document.querySelectorAll('.ting-tip').forEach(t => t.classList.add('above-actions'));
    }

    clearActionTimer() {
      if (this.actionTimer) { clearInterval(this.actionTimer); this.actionTimer = null; }
    }

    hideActions() {
      this.$('action-bar').classList.add('hidden');
      document.querySelectorAll('.ting-tip').forEach(t => t.classList.remove('above-actions'));
      this.clearActionTimer();
    }

    /** 通用操作询问，返回 Promise<value|null> */
    ask(buttons, timeoutSec) {
      return new Promise(resolve => {
        this.actionResolve = resolve;
        this.showActions(buttons, timeoutSec);
      });
    }

    /* =============== 交互：鸣牌询问 =============== */
    async askClaim(pid, options) {
      this.showHint('请选择动作 (不选将自动跳过)');
      const buttons = [];
      const win = options.find(o => o.type === 'win');
      if (win) buttons.push({ label: '和', cls: 'win', value: win });
      const kong = options.find(o => o.type === 'kong');
      if (kong) buttons.push({ label: '杠', value: kong });
      const pong = options.find(o => o.type === 'pong');
      if (pong) buttons.push({ label: '碰', value: pong });
      const chi = options.find(o => o.type === 'chi');
      if (chi) {
        chi.combos.forEach(c => {
          buttons.push({ label: '吃', sub: this.comboText(c), value: { ...chi, combo: c } });
        });
      }
      buttons.push({ label: '过', cls: 'pass', value: null });
      return this.ask(buttons, 10);
    }

    /** 吃牌组合的展示文本：组成顺子的三张牌 */
    comboText(combo) {
      const idxs = [this.engine.lastDiscard, ...combo].sort((a, b) => a - b);
      return idxs.map(i => MJ.tileName(i)).join(' ');
    }

    /** 自摸和牌询问 */
    askSelfDraw() {
      this.showHint('可以和牌！请选择');
      return this.ask([
        { label: '和 牌', cls: 'win', value: true },
        { label: '不 和', cls: 'pass', value: false },
      ], 10);
    }

    /** 每次开小局拿到牌后选择筹码（筹码即本局底注，局内外共享，输赢实时入代币） */
    askChip() {
      const econ = global.MJEconomy;
      return new Promise((resolve) => {
        const node = document.createDocumentFragment();
        node.appendChild(this.el('h2', '', '选 择 筹 码'));
        node.appendChild(this.el('div', 'subtitle',
          '筹码即本局底注：点炮者付 底注×倍率，自摸三家各付半注；输赢实时计入代币余额'));
        const opts = this.el('div', 'chip-opts');
        const chips = (econ && econ.CHIPS) || [100, 500, 1500];
        const fmtN = (v) => (econ ? econ.fmt(v) : String(v));
        chips.forEach((c) => {
          const b = this.el('button', 'chip-btn' + (c === 500 ? ' active' : ''));
          b.type = 'button';
          b.innerHTML = `<span class="chip-v">🪙 ${fmtN(c)}</span>` +
            `<span class="chip-sub">本局底注 ${fmtN(c)} · 输赢即时到账</span>`;
          b.addEventListener('click', () => {
            this.sound.tick();
            if (econ) econ.setChip(c);
            this.closeModal();
            resolve(c);
          });
          opts.appendChild(b);
        });
        node.appendChild(opts);
        this.openModal(node);
      });
    }

    /** 自己回合的杠选择 */
    async askKong(kongOptions) {
      this.showHint('可以杠牌，请选择');
      const buttons = kongOptions.map(k => ({
        label: k.kind === 'concealed' ? '暗 杠' : '加 杠',
        sub: MJ.tileName(k.tile),
        value: k,
      }));
      buttons.push({ label: '不 杠', cls: 'pass', value: null });
      return this.ask(buttons, 8);
    }

    /** 抢杠询问 */
    askRobKong(tile) {
      this.showHint('可以抢杠和牌！');
      return this.ask([
        { label: '抢杠和牌', cls: 'win', sub: MJ.tileName(tile), value: true },
        { label: '过', cls: 'pass', value: false },
      ], 10);
    }

    /* =============== 弹窗 =============== */
    openModal(contentNode, closableByEsc = false) {
      this._modalClosable = !!closableByEsc;
      const root = this.$('modal-root');
      root.innerHTML = '';
      const mask = this.el('div', 'modal-mask');
      const modal = this.el('div', 'modal');
      modal.appendChild(contentNode);
      mask.appendChild(modal);
      root.appendChild(mask);
      return { mask, modal };
    }
    closeModal() {
      this._modalClosable = false;
      this.$('modal-root').innerHTML = '';
    }

    /** 金币数字滚动 */
    countUp(node, target, dur) {
      if (!node) return;
      const D = dur || 900;
      const raf = (typeof requestAnimationFrame === 'function')
        ? requestAnimationFrame
        : (fn) => setTimeout(() => fn(Date.now()), 16);
      const t0 = Date.now();
      const step = () => {
        const k = Math.min(1, (Date.now() - t0) / D);
        const eased = 1 - Math.pow(1 - k, 3);
        node.textContent = fmtCoins(Math.round(target * eased));
        if (k < 1) raf(step);
      };
      raf(step);
    }

    winHandNodes(p, winTile, isSeven) {
      const box = this.el('div', 'win-hand-box');
      box.appendChild(this.el('div', 'label', '和 牌 型'));
      const row = this.el('div', 'win-tiles');
      p.melds.forEach(m => {
        const g = this.el('div', 'meld');
        m.tiles.forEach(t => g.appendChild(this.tileEl(t, { small: true })));
        row.appendChild(g);
      });
      const hand = p.hand.concat([winTile]).sort((a, b) => a - b);
      let markedWin = false;
      hand.forEach(t => {
        const isWin = !markedWin && t === winTile;
        if (isWin) markedWin = true;
        row.appendChild(this.tileEl(t, { small: true, cls: isWin ? 'win-tile' : '' }));
      });
      box.appendChild(row);
      return box;
    }

    /**
     * 结算弹窗 (金币制)
     * 清晰展示：底注 / 各牌型倍率 / 合计倍率 / 每家支付 / 最终赢得金额 / 各家金币变化
     */
    showSettlement(data) {
      return new Promise(resolve => {
        const { winner, selfDraw, fromDiscard, result, winTile } = data;
        const w = this.engine.players[winner];
        const node = document.createDocumentFragment();
        node.appendChild(this.el('h2', '', selfDraw ? '自 摸' : '和 牌'));
        const fromTxt = selfDraw ? '自摸和牌' : `由 ${SEAT_INFO[fromDiscard] ? SEAT_INFO[fromDiscard].name : '对家'} 点炮`;
        node.appendChild(this.el('div', 'subtitle',
          `${SEAT_INFO[winner].name} ${fromTxt} · 合计倍率 ×${result.totalMult}`));
        node.appendChild(this.winHandNodes(w, winTile, result.isSeven));

        // 赔率明细
        const table = this.el('table', 'fan-table');
        result.fans.forEach(f => {
          const tr = document.createElement('tr');
          tr.innerHTML = `<td>${f.name}${f.desc ? ` <span class="desc">${f.desc}</span>` : ''}</td><td>×${f.mult}</td>`;
          table.appendChild(tr);
        });
        const tr = document.createElement('tr');
        tr.className = 'total';
        tr.innerHTML = `<td>合计倍率</td><td>×${result.totalMult}</td>`;
        table.appendChild(tr);
        node.appendChild(table);

        // 金币结算板
        const board = this.el('div', 'coin-board');
        board.innerHTML =
          `<div class="coin-line"><span>底注</span><b>${fmtCoins(result.baseBet)}</b></div>` +
          `<div class="coin-line"><span>合计倍率</span><b>×${result.totalMult}</b></div>` +
          `<div class="coin-line"><span>${selfDraw ? '每家支付 (三家)' : '放炮者支付'}</span><b>${fmtCoins(result.perPayer)}</b></div>` +
          `<div class="coin-line win"><span>本局赢得</span><b id="win-coin">0</b><span class="unit">金币</span></div>`;
        node.appendChild(board);

        // 各家金币变化
        const scoreBox = this.el('div');
        data.payments.forEach(pay => {
          const p = this.engine.players[pay.player];
          const row = this.el('div', 'score-row');
          const cls = pay.delta > 0 ? 'plus' : (pay.delta < 0 ? 'minus' : '');
          const sign = pay.delta > 0 ? '+' : '';
          row.innerHTML = `
            <span class="who"><span class="avatar" style="background:${SEAT_INFO[p.id].color};width:24px;height:24px;font-size:12px">${SEAT_INFO[p.id].avatar}</span>${SEAT_INFO[p.id].name}</span>
            <span class="delta ${cls}">${pay.delta === 0 ? '-' : sign + fmtCoins(pay.delta)} (${fmtCoins(p.score)})</span>`;
          scoreBox.appendChild(row);
        });
        node.appendChild(scoreBox);

        // 局内外共享：本局代币实时结算
        const econ = global.MJEconomy;
        if (econ && data.coinDelta !== undefined && data.coinDelta !== null) {
          const bal = data.coinBalance != null ? data.coinBalance : econ.getCoins();
          const line = this.el('div', 'coin-delta ' + (data.coinDelta >= 0 ? 'gain' : 'loss'));
          line.textContent = (data.coinDelta >= 0 ? '代币 + ' : '代币 − ') + econ.fmt(Math.abs(data.coinDelta)) +
            ' · 余额 ' + econ.fmt(bal);
          node.appendChild(line);
          if (data.coinRelief > 0) {
            const tip = this.el('div', 'coin-relief', '破产补助 + ' + econ.fmt(data.coinRelief) + '，明天继续来把麻将！');
            node.appendChild(tip);
          }
        }

        const btns = this.el('div', 'modal-btns');
        const ok = this.el('button', 'act-btn', '继 续');
        ok.type = 'button';
        ok.addEventListener('click', () => { this.sound.tick(); this.closeModal(); resolve('next'); });
        btns.appendChild(ok);
        node.appendChild(btns);

        const { mask } = this.openModal(node);
        void mask;
        this.countUp(this.$('win-coin'), result.gain, 950);
      });
    }

    /** 流局弹窗 (coin: 本局代币结算信息，可为 null) */
    showDrawGame(tenpaiList, coin) {
      return new Promise(resolve => {
        const node = document.createDocumentFragment();
        node.appendChild(this.el('h2', '', '荒 庄'));
        const names = tenpaiList.map(i => SEAT_INFO[i].name).join('、');
        node.appendChild(this.el('div', 'subtitle', tenpaiList.length ? `听牌：${names} (不结算金币)` : '无人听牌'));
        const econ = global.MJEconomy;
        if (econ && coin) {
          const line = this.el('div', 'coin-delta ' + (coin.delta >= 0 ? 'gain' : 'loss'));
          line.textContent = (coin.delta >= 0 ? '代币 + ' : '代币 − ') + econ.fmt(Math.abs(coin.delta)) +
            ' · 余额 ' + econ.fmt(coin.balance);
          node.appendChild(line);
          if (coin.relief > 0) {
            const tip = this.el('div', 'coin-relief', '破产补助 + ' + econ.fmt(coin.relief) + '，明天继续来把麻将！');
            node.appendChild(tip);
          }
        }
        const btns = this.el('div', 'modal-btns');
        const ok = this.el('button', 'act-btn', '继 续');
        ok.type = 'button';
        ok.addEventListener('click', () => { this.sound.tick(); this.closeModal(); resolve(); });
        btns.appendChild(ok);
        node.appendChild(btns);
        this.openModal(node);
      });
    }

    /** 总结算 */
    showMatchOver() {
      return new Promise(resolve => {
        const players = this.engine.players.slice().sort((a, b) => b.score - a.score);
        const node = document.createDocumentFragment();
        node.appendChild(this.el('h2', '', '总 结 算'));
        node.appendChild(this.el('div', 'subtitle', '东一局 ~ 南四局 · 全场结束'));
        let playerRank = 0;
        players.forEach((p, i) => {
          if (p.id === 0) playerRank = i + 1;
          const row = this.el('div', 'rank-row');
          const medal = ['🥇', '🥈', '🥉', ''][i];
          row.innerHTML = `
            <span class="no">${i + 1}</span>
            <span class="avatar" style="background:${SEAT_INFO[p.id].color};width:28px;height:28px;font-size:12px">${SEAT_INFO[p.id].avatar}</span>
            <span class="nm">${SEAT_INFO[p.id].name} ${medal}</span>
            <span class="sc">${fmtCoins(p.score)}</span>`;
          node.appendChild(row);
        });
        /* 局内外共享：代币已在每局实时结算，这里只展示余额与名次 */
        const econ = global.MJEconomy;
        if (econ) {
          const line = this.el('div', 'coin-delta',
            '代币余额 ' + econ.fmt(econ.getCoins()) + '（每局输赢已实时计入 · 名次不影响代币）');
          node.appendChild(line);
        }
        const btns = this.el('div', 'modal-btns');
        const again = this.el('button', 'act-btn', '再 来 一 局');
        again.type = 'button';
        again.addEventListener('click', () => { this.sound.tick(); this.closeModal(); resolve('again'); });
        btns.appendChild(again);
        // 回主界面：整场结束后给一条「不继续打」的出口
        const home = this.el('button', 'act-btn pass', '回 主 界 面');
        home.type = 'button';
        home.addEventListener('click', () => {
          this.sound.tick(); this.closeModal();
          if (typeof global.__mjBackHome === 'function') global.__mjBackHome();
        });
        btns.appendChild(home);
        node.appendChild(btns);
        this.openModal(node);
        this.sound.chime();
      });
    }

    /** 规则 + 赔率表 */
    showRules() {
      const E = global.MJEngine || {};
      const odds = (E.FAN_MULT || []).map(f =>
        `<div class="odds-row"><span>${f.name}</span><b>×${f.mult}</b></div>`).join('');
      const node = document.createDocumentFragment();
      node.appendChild(this.el('h2', '', '玩 法 规 则'));
      const body = this.el('div', 'rules-text');
      body.innerHTML = `
        <h3>基本</h3>
        <ul>
          <li>四人麻将，136 张牌 (万、筒、条 + 东南西北中发白)，无花牌。</li>
          <li>起手 13 张，庄家 14 张先出；轮流摸牌打牌，先组成 4 组面子 + 1 对雀头者胜。</li>
          <li>面子 = 顺子 (如 234 万) 或刻子 (如 3 张东风)；也支持七对子。</li>
        </ul>
        <h3>操作与辅助</h3>
        <ul>
          <li><b>吃</b>：仅上家 (左手边) 打出的牌可吃，须与手牌组成顺子。</li>
          <li><b>碰</b>：任何一家打出的牌，手中有 2 张即可碰。</li>
          <li><b>杠</b>：手牌 4 张相同可暗杠；碰过后再摸到可加杠；他人打出第 4 张可明杠。杠后摸一张岭上牌，加杠可被抢杠。</li>
          <li><b>和</b>：摸到所需牌为自摸；他人打出所需牌为点炮。</li>
          <li><b>听牌辅助</b>：出牌时带「听」角标的牌打出即可听牌，悬停或选中手牌可实时查看所听牌张及牌桌同名牌高亮；支持方向键选牌、回车/空格出牌。</li>
        </ul>
        <h3>金币结算</h3>
        <ul>
          <li>开局每人 <b>${fmtCoins(E.START_SCORE || 0)}</b> 金币；每次开小局拿到牌后先选<b>筹码</b> (100 / 500 / 1500)，筹码即<b>本局底注</b>。</li>
          <li>不同牌型倍率不同，<b>最终倍率 = 各倍率之积</b> (封顶 ×${E.MULT_CAP || 0})，按高点法择优结算。</li>
          <li>点炮：放炮者独付「底注 × 倍率」；自摸：三家各付「底注 × 倍率 ÷ 2」，赢家共得三份。</li>
          <li>暗杠每家付「底注 × 1」，明杠 / 加杠每家付「底注 × 0.5」。</li>
          <li>玩家的金币输赢<b>实时计入局外代币余额</b> (局内外共享)；庄家和牌或荒庄听牌则连庄，东一局至南四局共 8 局后总结算，名次仅作展示不影响代币。</li>
        </ul>
        <h3>赔率表</h3>
        <div class="odds-hint">同一手牌可叠加多个牌型，倍率相乘。</div>
        <div class="odds-grid">${odds}</div>`;
      node.appendChild(body);
      const btns = this.el('div', 'modal-btns');
      const ok = this.el('button', 'act-btn', '知 道 了');
      ok.type = 'button';
      ok.addEventListener('click', () => { this.sound.tick(); this.closeModal(); });
      btns.appendChild(ok);
      node.appendChild(btns);
      this.openModal(node, true);
    }

    toast(text, ms = 1800) {
      const t = this.$('toast');
      t.textContent = text;
      t.classList.remove('hidden');
      clearTimeout(this._toastTimer);
      this._toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
    }
  }

  global.MJUI = { UI, SEAT_INFO, WIND_NAMES, fmtCoins, coinShort };
})(window);
