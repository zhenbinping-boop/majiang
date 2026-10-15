/**
 * game.js - 对局控制器：编排引擎 / AI / UI 的完整对局流程
 * 发牌 → 回合轮转 (摸牌/杠/弃牌) → 鸣牌结算 (吃碰杠胡/抢杠) → 和牌或荒庄 → 番型结算 → 连庄换庄 → 总结算
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
      this._runId = 0;
      this._topbarBound = false;
    }

    isAlive(runId) {
      return this.running && (runId === undefined || this._runId === runId);
    }

    /* ---------- 入口 ---------- */
    async start() {
      const runId = ++this._runId;
      this.running = true;
      this.bindTopbar();
      this.engine.startMatch();
      await this.handLoop(runId);
    }

    restart() {
      this._runId++;
      this.running = false;
      if (this.ui.cancelPendingInteractions) this.ui.cancelPendingInteractions();
      this.ui.closeModal();
      this.ui.hideActions();
      setTimeout(() => this.start(), 60);
    }

    bindTopbar() {
      if (this._topbarBound) return;
      this._topbarBound = true;
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
      const themeBtn = ui.$('btn-theme');
      if (themeBtn) {
        themeBtn.addEventListener('click', () => {
          ui.sound.tick();
          if (ui.t3d && ui.t3d.cycleTheme) {
            ui.toast('雀桌皮肤 · ' + ui.t3d.cycleTheme());
          } else {
            ui.toast('皮肤切换需 WebGL 3D 牌桌');
          }
        });
      }
      ui.$('btn-restart').addEventListener('click', () => this.confirmRestart());
      const home = ui.$('btn-home');
      if (home) home.addEventListener('click', () => this.confirmHome());
    }

    /** 顶栏「返回主界面」：停掉当前对局，回到主界面（对局对象保留，可「继续上局」） */
    confirmHome() {
      const ui = this.ui;
      const node = document.createDocumentFragment();
      node.appendChild(ui.el('h2', '', '返 回 主 界 面'));
      node.appendChild(ui.el('div', 'subtitle', '当前对局会暂停，可从主界面「继续上局」回来。'));
      const btns = ui.el('div', 'modal-btns');
      const yes = ui.el('button', 'act-btn', '返回');
      yes.type = 'button';
      yes.addEventListener('click', () => {
        ui.sound.tick(); ui.closeModal();
        if (typeof window.__mjBackHome === 'function') window.__mjBackHome();
      });
      const no = ui.el('button', 'act-btn pass', '继续打');
      no.type = 'button';
      no.addEventListener('click', () => { ui.sound.tick(); ui.closeModal(); });
      btns.appendChild(yes); btns.appendChild(no);
      node.appendChild(btns);
      ui.openModal(node);
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
    async handLoop(runId) {
      while (this.isAlive(runId)) {
        const result = await this.playHand(runId);
        if (!this.isAlive(runId) || !result) return;
        if (result.isDraw) {
          this.engine.updateTenpaiFlags();
          const tenpai = this.engine.settleDraw();
          this.ui.renderAll();
          await this.ui.showDrawGame(tenpai);
        } else {
          await this.ui.showSettlement(result.settleData);
        }
        if (!this.isAlive(runId)) return;

        // nextHand 返回 false 表示整场 (东1~南4 共 8 局) 结束
        if (this.engine.matchOver || !this.engine.nextHand(result.dealerWon, result.isDraw)) {
          this.engine.matchOver = true;
          const again = await this.ui.showMatchOver();
          if (!this.isAlive(runId)) return;
          if (again === 'again') { this.restart(); return; }
          this.running = false;
          return;
        }
        // animateDeal 内部会先做一次全量渲染，再让手牌逐张进场，避免二次重渲染
        await this.ui.animateDeal();
      }
    }

    /* ---------- 单局 ---------- */
    async playHand(runId) {
      await this.ui.animateDeal();
      if (!this.isAlive(runId)) return null;
      let guard = 0;
      let justClaimedPongOrChi = false;
      while (this.isAlive(runId) && guard++ < 400) {
        const p = this.engine.players[this.engine.turn];
        this.ui.setTurn(p.id);

        if (this.engine.needsDraw(p)) {
          const tile = this.engine.drawTile(p);
          if (tile === null) return { isDraw: true, dealerWon: false };
          await this.ui.animateDraw(p.id, tile);
          if (!this.isAlive(runId)) return null;
          this.ui.renderTopbar();
        }

        // 正常摸牌、庄家首巡起手 14 张、或杠后补完岭上牌时，均可判定自摸和牌与暗杠/加杠
        if (!justClaimedPongOrChi) {
          if (this.engine.canWin(p)) {
            let take;
            if (p.isHuman) {
              this.ui.toast(p.lastDrawWasReplacement ? '杠上开花！' : '可以和牌！');
              take = await this.ui.askSelfDraw();
            } else {
              await delay(aiThink());
              take = true; // AI 和牌必取
            }
            if (!this.isAlive(runId)) return null;
            if (take) {
              return this.win(p, {
                selfDraw: true,
                rinshan: !!p.lastDrawWasReplacement,
                haitei: !!p.lastDrawWasLast,
              });
            }
          }

          // 杠 (暗杠 / 加杠)
          if (p.isHuman) {
            const kongs = [];
            this.engine.findConcealedKongs(p).forEach(t => kongs.push({ kind: 'concealed', tile: t }));
            this.engine.findAddedKongs(p).forEach(t => kongs.push({ kind: 'added', tile: t }));
            if (kongs.length) {
              const k = await this.ui.askKong(kongs);
              if (!this.isAlive(runId)) return null;
              if (k) {
                const r = await this.doKong(p, k, runId);
                if (!this.isAlive(runId)) return null;
                if (r) return r;
                continue; // 杠后已摸岭上牌，回到循环顶部检测杠上开花或连续杠
              }
            }
          } else {
            const k = this.ai.decideKong(p);
            if (k) {
              await delay(aiThink());
              if (!this.isAlive(runId)) return null;
              const r = await this.doKong(p, k, runId);
              if (!this.isAlive(runId)) return null;
              if (r) return r;
              continue;
            }
          }
        }
        justClaimedPongOrChi = false;

        // 舍牌
        let tile;
        if (p.isHuman) {
          tile = await this.ui.askDiscard();
        } else {
          await delay(aiThink());
          tile = this.ai.chooseDiscard(p);
        }
        if (!this.isAlive(runId)) return null;
        if (tile === undefined || tile === null || !p.hand.includes(tile)) {
          tile = p.hand[p.hand.length - 1];
        }

        this.engine.discard(p, tile);
        this.ui.animateDiscard(p.id, tile);
        await delay(300);
        if (!this.isAlive(runId)) return null;

        // 鸣牌结算
        const outcome = await this.resolveClaims(runId);
        if (!this.isAlive(runId)) return null;
        if (outcome.win || outcome.isDraw) return outcome;
        if (outcome.claimed) {
          justClaimedPongOrChi = !outcome.fromKong;
        } else {
          this.engine.turn = (this.engine.turn + 1) % 4;
        }
      }
      return { isDraw: true, dealerWon: false };
    }

    /* ---------- 杠流程 (含抢杠与岭上摸牌) ---------- */
    async doKong(p, k, runId) {
      if (k.kind === 'concealed') this.engine.declareConcealedKong(p, k.tile);
      else this.engine.declareAddedKong(p, k.tile);
      this.ui.renderAll();
      this.ui.sound.kong();
      this.ui.flash('杠', 'kong');
      await delay(620);
      if (!this.isAlive(runId)) return null;

      // 抢杠 (仅加杠可抢；被抢杠则加杠不成立，不结算杠分)
      const rob = this.engine.robKongOptions();
      if (rob.length) {
        for (const r of rob) {
          const rp = this.engine.players[r.player];
          let take;
          if (rp.isHuman) take = await this.ui.askRobKong(r.tile);
          else { await delay(aiThink()); take = this.ai.decideRobKong(rp, r.tile); }
          if (!this.isAlive(runId)) return null;
          if (take) {
            this.ui.toast('抢杠和牌！');
            return this.win(rp, { robKong: true, fromDiscard: p.id });
          }
        }
      }

      // 未被抢杠，结算杠分并摸岭上牌
      this.engine.settleKongPoints(p, k.kind === 'concealed');
      this.ui.renderAll();

      const t2 = this.engine.drawTile(p, true);
      if (t2 === null) return { isDraw: true, dealerWon: false };
      await this.ui.animateDraw(p.id, t2);
      if (!this.isAlive(runId)) return null;
      this.ui.renderTopbar();
      return null;
    }

    /* ---------- 鸣牌结算 ---------- */
    async resolveClaims(runId) {
      const discarder = this.engine.lastDiscarder;
      const opts = this.engine.claimOptions(discarder, this.engine.lastDiscard);
      if (!opts.length) return {};

      const decided = [];
      // AI 决策 (带思考延时，按座位顺序；每个玩家只决策一次)
      const aiSeats = [...new Set(opts.filter(o => o.player !== 0).map(o => o.player))].sort((a, b) => a - b);
      for (const pid of aiSeats) {
        const p = this.engine.players[pid];
        await delay(aiThink() * 0.55);
        if (!this.isAlive(runId)) return {};
        const dec = this.ai.decideClaim(opts.filter(x => x.player === pid), p);
        if (dec) decided.push(dec);
      }
      // 人类决策
      const myOpts = opts.filter(o => o.player === 0);
      if (myOpts.length) {
        const dec = await this.ui.askClaim(0, myOpts);
        if (!this.isAlive(runId)) return {};
        if (dec) decided.push(dec);
      }
      if (!decided.length) return {};

      // 优先级：和 > 杠 > 碰 > 吃，同级按距出牌者的逆时针座序优先 (截胡)
      const rank = { win: 0, kong: 1, pong: 2, chi: 3 };
      const dist = (pid) => (pid - discarder + 4) % 4;
      decided.sort((a, b) => rank[a.type] - rank[b.type] || dist(a.player) - dist(b.player));
      const d0 = decided[0];
      const p1 = this.engine.players[d0.player];

      if (d0.type === 'win') {
        return this.win(p1, { selfDraw: false, fromDiscard: discarder, haitei: false });
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
        this.engine.settleKongPoints(p1, false);
        await this.ui.animateClaim(d0.player, 'kong');
        this.ui.renderAll();
        await delay(420);
        const t2 = this.engine.drawTile(p1, true);
        if (t2 === null) return { isDraw: true, dealerWon: false };
        await this.ui.animateDraw(p1.id, t2);
        this.ui.renderTopbar();
        return { claimed: true, fromKong: true };
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
      // 胡牌音效与浮字，先给玩家一个明确的“胡了”反馈再弹结算（自摸专属语音）
      if (opts.selfDraw) this.ui.sound.zimo(); else this.ui.sound.win();
      this.ui.flash('胡', 'win');
      await delay(820);
      const data = {
        winner: winner.id,
        selfDraw: !!opts.selfDraw,
        fromDiscard: opts.fromDiscard !== undefined ? opts.fromDiscard : -1,
        result, payments, winTile,
      };
      return { win: true, dealerWon: winner.dealer, settleData: data };
    }
  }

  global.MJGame = { GameController };
})(typeof window !== 'undefined' ? window : this);
