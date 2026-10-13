/**
 * tests/soak.js — 大规模无头 soak 测试（后台运行）
 * 运行: node tests/soak.js [局数]
 */
'use strict';
const E = require('../js/engine.js');
const { MahjongAI } = require('../js/ai.js');

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function playHand(game, ai) {
  let guard = 0, skipDraw = false;
  while (guard++ < 400) {
    const p = game.players[game.turn];
    if (!skipDraw && game.needsDraw(p)) {
      const tile = game.drawTile(p);
      if (tile === null) { game.updateTenpaiFlags(); game.settleDraw(); return { dealerWon: false, isDraw: true }; }
      if (game.canWin(p)) { game.settleWin(p, { selfDraw: true, haitei: p.lastDrawWasLast }); return { dealerWon: p.dealer, isDraw: false }; }
      const kong = ai.decideKong(p);
      if (kong) {
        if (kong.kind === 'concealed') game.declareConcealedKong(p, kong.tile);
        else game.declareAddedKong(p, kong.tile);
        game.settleKongPoints(p, kong.kind === 'concealed');
        const rob = game.robKongOptions();
        if (rob.length) { game.settleWin(game.players[rob[0].player], { robKong: true, fromDiscard: p.id }); return { dealerWon: game.players[rob[0].player].dealer, isDraw: false }; }
        const t2 = game.drawTile(p, true);
        if (t2 === null) { game.updateTenpaiFlags(); game.settleDraw(); return { dealerWon: false, isDraw: true }; }
        if (game.canWin(p)) { game.settleWin(p, { selfDraw: true, rinshan: true }); return { dealerWon: p.dealer, isDraw: false }; }
      }
    }
    skipDraw = false;
    const d = ai.chooseDiscard(p);
    if (d === undefined || !p.hand.includes(d)) throw new Error('AI 弃牌非法: ' + d);
    game.discard(p, d);
    const opts = game.claimOptions(p.id, d);
    const decided = [];
    for (const o of opts) {
      const dec = ai.decideClaim(opts.filter(x => x.player === o.player), game.players[o.player]);
      if (dec) decided.push(dec);
    }
    if (decided.length) {
      const d0 = decided[0];
      const pl = game.players[d0.player];
      if (d0.type === 'win') { game.settleWin(pl, { selfDraw: false, fromDiscard: p.id, haitei: game.wall.length === 0 }); return { dealerWon: pl.dealer, isDraw: false }; }
      if (d0.type === 'pong') game.applyPong(d0.player);
      else if (d0.type === 'kong') {
        game.applyKongFromDiscard(d0.player);
        game.settleKongPoints(pl, false);
        const t2 = game.drawTile(pl, true);
        if (t2 !== null && game.canWin(pl)) { game.settleWin(pl, { selfDraw: true, rinshan: true }); return { dealerWon: pl.dealer, isDraw: false }; }
        if (t2 === null) { game.updateTenpaiFlags(); game.settleDraw(); return { dealerWon: false, isDraw: true }; }
      } else if (d0.type === 'chi') game.applyChi(d0.player, d0.combos[0]);
      game.turn = d0.player;
      skipDraw = true;
      continue;
    }
    game.turn = (game.turn + 1) % 4;
  }
  throw new Error('单局超巡');
}

const N = parseInt(process.argv[2] || '200', 10);
const t0 = Date.now();
let hands = 0, wins = 0, draws = 0, errors = 0, nonConserved = 0;
const winByPlayer = [0, 0, 0, 0];
for (let seed = 1000; seed < 1000 + N; seed++) {
  try {
    const game = new E.MahjongGame({ rng: mulberry32(seed) });
    const ai = new MahjongAI(game);
    game.startMatch();
    let h = 0;
    while (!game.matchOver && h < 40) {
      const r = playHand(game, ai);
      h++;
      if (r.isDraw) draws++; else { wins++; }
      game.nextHand(r.dealerWon, r.isDraw);
    }
    hands += h;
    const sum = game.players.reduce((s, p) => s + p.score, 0);
    if (sum !== E.START_SCORE * 4) nonConserved++;
  } catch (e) {
    errors++;
    if (errors <= 3) console.error('seed', seed, e.message);
  }
}
console.log(`soak 完成：${N} 场对局 / ${hands} 局，和牌 ${wins}（${(wins / hands * 100).toFixed(1)}%），流局 ${draws}（${(draws / hands * 100).toFixed(1)}%），异常 ${errors}，分数不守恒 ${nonConserved}，耗时 ${Date.now() - t0}ms`);
process.exit(errors > 0 || nonConserved > 0 ? 1 : 0);
