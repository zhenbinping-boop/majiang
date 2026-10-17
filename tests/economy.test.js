/**
 * tests/economy.test.js — 局外代币经济模块专项验证
 * 覆盖：50 万初始资金、筹码选择、每局实时结算（直连钱包）、皮肤解锁/余额不足、破产补助每日一次
 */
const path = require('path');
const fs = require('fs');
const vm = require('vm');

/* localStorage 桩（内存版） */
const store = new Map();
global.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

/* 以 window=globalThis 的语义加载 economy.js（其 IIFE 绑定 window||this） */
const src = fs.readFileSync(path.resolve(__dirname, '..', 'js', 'economy.js'), 'utf8');
const ctx = { localStorage: global.localStorage, document: undefined };
ctx.window = ctx;   /* economy.js 的 IIFE 参数 = window，挂到沙箱全局 */
vm.createContext(ctx);
vm.runInContext(src, ctx);
const E = ctx.window.MJEconomy;

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name); }
}

console.log('== 资金初始化 ==');
ok(E.START_COINS === 500000, '初始资金常量 500,000');
ok(E.getCoins() === 500000, '首次启动赠 50 万代币（实际 ' + E.getCoins() + '）');

console.log('== 筹码选择 ==');
ok(JSON.stringify(E.CHIPS) === '[100,500,1500]', '筹码选项 100/500/1500');
ok(E.getChip() === 500, '默认筹码 500');
ok(E.setChip(1500) === 1500 && E.getChip() === 1500, '选大筹 1500');
ok(E.setChip(9999) === 1500, '非法筹码被拒绝，保持 1500');
E.setChip(100);
ok(E.getChip() === 100, '选小筹 100');

console.log('== 每局实时结算（局内外共享，直连钱包）==');
ok(E.settleMatch === undefined, '名次结算接口已移除（名次不影响代币）');
let d = E.addCoins(18000);   // 筹码 1500 清一色自摸一例
ok(d === 518000, '赢 18,000 实时入账（实际 ' + d + '）');
d = E.addCoins(-23000);      // 点炮大番一例
ok(d === 495000, '输 23,000 实时扣款（实际 ' + d + '）');
d = E.addCoins(-999999);
ok(d === 0, '输到下限截断为 0');
E.addCoins(495000);          // 还原到 495,000，供皮肤用例使用

console.log('== 皮肤解锁 ==');
let r = E.unlockSkin('ocean');
ok(r.ok && E.isUnlocked('ocean'), '49.5 万资金解锁 8,000 鎏金成功');
ok(E.getCoins() === 487000, '扣款后余额 487,000（实际 ' + E.getCoins() + '）');
r = E.unlockSkin('ocean');
ok(!r.ok && r.reason === 'owned', '重复解锁 → owned');
r = E.unlockSkin('sandal');
ok(r.ok && E.isUnlocked('sandal'), '15,000 解锁玄金成功');
r = E.unlockSkin('nope');
ok(!r.ok && r.reason === 'no-skin', '未知皮肤 → no-skin');
ok(E.ownedSkins().length === 3 && E.ownedSkins().indexOf('jade') >= 0, '翡翠始终默认拥有');

console.log('== 破产补助（<2,000 补到 20,000，每日一次）==');
E.addCoins(-999999); // → 0（下限截断）
ok(E.getCoins() === 0, '余额下限截断为 0（实际 ' + E.getCoins() + '）');
const g1 = E.maybeRelief();
ok(g1 === 20000 && E.getCoins() === 20000, '补助 +20,000（实际 +' + g1 + '）');
const g2 = E.maybeRelief();
ok(g2 === 0, '同一天二次触发 → 0');
E.addCoins(-19000); // → 1,000 < 2,000
ok(E.maybeRelief() === 0, '低于阈值但今日已领 → 0');

console.log('== 持久化 ==');
ok(store.get('mj-coins') === '1000', '余额已写回存储');ok(JSON.parse(store.get('mj-unlocked')).indexOf('ocean') >= 0, '解锁清单已持久化');
ok(store.get('mj-stake') === undefined, '旧局级键已不再写入');

console.log('\n========== 通过 ' + pass + ' / 失败 ' + fail + ' ==========');
process.exit(fail ? 1 : 0);
