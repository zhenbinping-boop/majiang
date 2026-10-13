/**
 * game.js — 对局控制器：编排引擎 / AI / UI 的完整对局流程
 * 发牌 → 回合轮转（摸牌/杠/弃牌）→ 鸣牌结算（吃碰杠胡/抢杠）→ 和牌或荒庄 → 番型结算 → 连庄换庄 → 总结算
 */
(function (global) {
  'use strict';

  const delay = (ms) => new Promise(r => setTimeout(r, ms));
  const aiThink = () => 550 + Math.random() * 750;

  class GameController {
    constructor() {
      this.engine = new global.MJEngine.MahjongGame({
        names: global.MJUI.SEAT_INFO.map(s => s.name),
      });
      this.ai = new global.MJAI.MahjongAI(this.engine);
      this.ui = new global.MJUI.UI(this);
      this.running = false;
    }

    /* ---------- 入口 ---------- */
    async start() {
      this.running = true;
      this.bindTopbar();
      this.engine.startMatch();
      await this.handLoop();
    }

    restart() {
      this.ui.closeModal();
      this.ui.hideActions();
      this.running = false;
      setTimeout(() => this.start(), 60);
    }

    bindTopbar() {
      const ui = this.ui;
      ui.$('btn-sound').addEventListener('click', () => {
        ui.sound.muted = !ui.sound.muted;
        ui.$('btn-sound').textContent = ui.sound.muted ? '🔇' : '🔊';
        ui.$('btn-sound').classList.toggle('muted', ui.sound.muted);
        // 静音时同时掐断正在播放的喊牌语音
        if (ui.sound.muted && typeof window !== 'undefined' && window.speechSynthesis) {
          try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
        }
        if (!ui.sound.muted) ui.sound.tick();
      });
      ui.$('btn-rules').addEventListener('click', () => ui.showRules());
      ui.$('btn-restart').addEventListener('click', () => this.confirmRestart());
    }

    confirmRestart() {
      const ui = this.ui;
      const node = document.createDocumentFragment();
      node.appendChild(ui.el('h2', '', '重 新 开 局'));
      node.appendChild(ui.el('div', 'subtitle', '当前对局进度将清零，确定吗？'));
      const btns = ui.el('div', 'modal-btns');
      const yes = ui.el('button', 'act-btn', '确定重开');
      yes.type = 'button';
      yes.addEventListener('click', () => { ui.sound.tick(); ui.closeModal(); this.restart(); });
      const no = ui.el('button', 'act-btn pass', '取消');
      no.type = 'button';
      no.addEventListener('click', () => { ui.sound.tick(); ui.closeModal(); });
      btns.appendChild(yes); btns.appendChild(no);
      node.appendChild(btns);
      ui.openModal(node);
    }

    /* ---------- 局循环 ---------- */
    async handLoop() {
      while (this.running) {
        const result = await this.playHand();
        if (result.isDraw) {
          this.engine.updateTenpaiFlags();
          const tenpai = this.engine.settleDraw();
          this.ui.renderAll();
          await this.ui.showDrawGame(tenpai);
        } else {
          await this.ui.showSettlement(result.settleData);
        }
        if (!this.running) return;

        // nextHand 返回 false 表示整场（东1~南4 共 8 局）结束
        if (this.engine.matchOver || !this.engine.nextHand(result.dealerWon, result.isDraw)) {
          this.engine.matchOver = true;
          const again = await this.ui.showMatchOver();
          if (again === 'again') { this.restart(); return; }
          this.running = false;
          return;
        }
        // animateDeal 内部会先做一次全量渲染，再让手牌逐张进场，避免二次重渲染
        await this.ui.animateDeal();
      }
    }

    /* ---------- 单局 ---------- */
    async playHand() {
      await this.ui.animateDeal();
      let guard = 0;
      while (this.running && guard++ < 400) {
        const p = this.engine.players[this.engine.turn];
        this.ui.setTurn(p.id);

        if (this.engine.needsDraw(p)) {
          const tile = this.engine.drawTile(p);
          if (tile === null) return { isDraw: true, dealerWon: false };
          await this.ui.animateDraw(p.id, tile);
          this.ui.renderTopbar();

          // 自摸和牌
          if (this.engine.canWin(p)) {
            let take;
            if (p.isHuman) {
              this.ui.toast('可以和牌！');
              take = await this.ui.askSelfDraw();
            } else {
              await delay(aiThink());
              take = true; // AI 和牌必取
            }
            if (take) return this.win(p, { selfDraw: true, haitei: p.lastDrawWasLast });
          }

          // 杠（暗杠 / 加杠）
          if (p.isHuman) {
            const kongs = [];
            this.engine.findConcealedKongs(p).forEach(t => kongs.push({ kind: 'concealed', tile: t }));
            this.engine.findAddedKongs(p).forEach(t => kongs.push({ kind: 'added', tile: t }));
            if (kongs.length) {
              const k = await this.ui.askKong(kongs);
              if (k) {
                const r = await this.doKong(p, k);
                if (r) return r;
                continue; // 杠后进入舍牌
              }
            }
          } else {
            await delay(aiThink());
            const k = this.ai.decideKong(p);
            if (k) {
              const r = await this.doKong(p, k);
              if (r) return r;
              continue;
            }
          }
        }

        // 舍牌
        let tile;
        if (p.isHuman) {
          tile = await this.ui.askDiscard();
        } else {
          await delay(aiThink());
          tile = this.ai.chooseDiscard(p);
        }
        if (tile === undefined || tile === null) tile = p.hand[p.hand.length - 1];

        this.engine.discard(p, tile);
        this.ui.animateDiscard(p.id, tile);
        await delay(300);

        // 鸣牌结算
        const outcome = await this.resolveClaims();
        if (outcome.win || outcome.isDraw) return outcome;
        if (!outcome.claimed) {
          this.engine.turn = (this.engine.turn + 1) % 4;
        }
      }
      return { isDraw: true, dealerWon: false };
    }

    /* ---------- 杠流程（含抢杠与岭上开花） ---------- */
    async doKong(p, k) {
      if (k.kind === 'concealed') this.engine.declareConcealedKong(p, k.tile);
      else this.engine.declareAddedKong(p, k.tile);
      this.engine.settleKongPoints(p, k.kind === 'concealed');
      this.ui.renderAll();
      this.ui.sound.kong();
      this.ui.flash('杠', 'kong');
      await delay(620);

      // 抢杠（仅加杠可抢）
      const rob = this.engine.robKongOptions();
      if (rob.length) {
        for (const r of rob) {
          const rp = this.engine.players[r.player];
          let take;
          if (rp.isHuman) take = await this.ui.askRobKong(r.tile);
          else { await delay(aiThink()); take = this.ai.decideRobKong(rp, r.tile); }
          if (take) {
            this.ui.toast('抢杠和牌！');
            return this.win(rp, { robKong: true, fromDiscard: p.id });
          }
        }
      }

      // 岭上摸牌
      const t2 = this.engine.drawTile(p, true);
      if (t2 === null) return { isDraw: true, dealerWon: false };
      await this.ui.animateDraw(p.id, t2);
      this.ui.renderTopbar();

      // 杠上开花
      if (this.engine.canWin(p)) {
        if (p.isHuman) {
          this.ui.toast('杠上开花！');
          const take = await this.ui.askSelfDraw();
          if (take) return this.win(p, { selfDraw: true, rinshan: true });
        } else {
          return this.win(p, { selfDraw: true, rinshan: true });
        }
      }
      return null;
    }

    /* ---------- 鸣牌结算 ---------- */
    async resolveClaims() {
      const discarder = this.engine.lastDiscarder;
      const opts = this.engine.claimOptions(discarder, this.engine.lastDiscard);
      if (!opts.length) return {};

      const decided = [];
      // AI 决策（带思考延时，按座位顺序；每个玩家只决策一次）
      const aiSeats = [...new Set(opts.filter(o => o.player !== 0).map(o => o.player))].sort((a, b) => a - b);
      for (const pid of aiSeats) {
        const p = this.engine.players[pid];
        await delay(aiThink() * 0.55);
        const dec = this.ai.decideClaim(opts.filter(x => x.player === pid), p);
        if (dec) decided.push(dec);
      }
      // 人类决策
      const myOpts = opts.filter(o => o.player === 0);
      if (myOpts.length) {
        const dec = await this.ui.askClaim(0, myOpts);
        if (dec) decided.push(dec);
      }
      if (!decided.length) return {};

      // 优先级：和 > 杠 > 碰 > 吃，同级按座位序
      const rank = { win: 0, kong: 1, pong: 2, chi: 3 };
      decided.sort((a, b) => rank[a.type] - rank[b.type] || a.player - b.player);
      const d0 = decided[0];
      const pl = this.engine.players[d0.player];

      if (d0.type === 'win') {
        return this.win(pl, { selfDraw: false, fromDiscard: discarder, haitei: this.engine.wall.length === 0 });
      }
      if (d0.type === 'pong') {
        this.engine.applyPong(d0.player);
        await this.ui.animateClaim(d0.player, 'pong');
        this.ui.renderAll();
        await delay(300);
        return { claimed: true };
      }
      if (d0.type === 'kong') {
        this.engine.applyKongFromDiscard(d0.player);
        this.engine.settleKongPoints(pl, false);
        await this.ui.animateClaim(d0.player, 'kong');
        this.ui.renderAll();
        await delay(420);
        const t2 = this.engine.drawTile(pl, true);
        if (t2 === null) return { isDraw: true, dealerWon: false };
        await this.ui.animateDraw(pl.id, t2);
        this.ui.renderTopbar();
        if (this.engine.canWin(pl)) {
          if (pl.isHuman) {
            this.ui.toast('杠上开花！');
            const take = await this.ui.askSelfDraw();
            if (take) return this.win(pl, { selfDraw: true, rinshan: true });
          } else {
            return this.win(pl, { selfDraw: true, rinshan: true });
          }
        }
        return { claimed: true };
      }
      if (d0.type === 'chi') {
        const combo = d0.combo || (d0.combos && d0.combos[0]);
        this.engine.applyChi(d0.player, combo);
        await this.ui.animateClaim(d0.player, 'chi');
        this.ui.renderAll();
        await delay(300);
        return { claimed: true };
      }
      return {};
    }

    /* ---------- 和牌 ---------- */
    async win(winner, opts) {
      const { result, payments, winTile } = this.engine.settleWin(winner, opts);
      this.engine.updateTenpaiFlags();
      this.ui.renderAll();
      // 胡牌音效与浮字，先给玩家一个明确的“胡了”反馈再弹结算
      this.ui.sound.win();
      this.ui.flash('胡', 'win');
      await delay(820);
      const data = {
        winner: winner.id,
        selfDraw: !!opts.selfDraw,
        fromDiscard: opts.fromDiscard !== undefined ? opts.fromDiscard : -1,
        result, payments, winTile,
      };
      return { win: true, isDraw: false, dealerWon: winner.dealer, settleData: data };
    }
  }

  global.MJGame = { GameController };
})(window);
