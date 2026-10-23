/**
 * 容量实测：node scripts/measure-size.mjs
 *
 * 用真实的 store.js 造数据，量导出 JSON 的字节数。
 * 目的不是"localStorage 能存多少"（那是浏览器给的、且各版本不同），
 * 而是"本站会用到多少" —— 只有后者是你真正需要关心的那个数。
 */
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
if (!globalThis.crypto) {
  const { webcrypto } = await import('node:crypto');
  globalThis.crypto = webcrypto;
}

const S = await import('../src/store.js?case=size');
const { gzipSync } = await import('node:zlib');
const bytes = (s) => Buffer.byteLength(s, 'utf8');
const kb = (n) => (n / 1024).toFixed(1);

// 导出文本到底多长 —— 这才是"能不能粘进微信/QQ 搬到另一台设备"的关键数字
const sizeReport = (label, json) => {
  const raw = bytes(json);
  const gz = gzipSync(Buffer.from(json, 'utf8')).length;
  const b64 = Buffer.from(gzipSync(Buffer.from(json, 'utf8'))).toString('base64').length;
  console.log(`  ${label.padEnd(22)} 原文 ${kb(raw).padStart(7)} KB | gzip ${kb(gz).padStart(6)} KB | gzip+base64 ${kb(b64).padStart(6)} KB`);
};

const baseline = bytes(S.exportJson());
console.log(`空档（1 个分类 + 10 条示例）      ${kb(baseline)} KB`);

// 单个条目记录多大
const one = S.addDish(S.tabList()[0].id, '测试菜名长度参照');
const perDish = bytes(JSON.stringify(one.dish));
console.log(`单条条目记录（含 ISO 时间戳）     ${perDish} B`);

// 单条抽签记录多大
S.togglePick(one.dish.id);
S.draw(S.tabList()[0].id);
const rec = S.recordOf(S.today(), S.tabList()[0].id);
console.log(`单条抽签记录（含名字快照）        ${bytes(JSON.stringify(rec))} B`);

// 真实场景推演：分类拉满 8 个、每个 200 道菜、每天每类都掷一次并连用一年
S.resetToSeed();
for (let i = 0; i < S.MAX_TABS - 1; i++) S.addTab();
const tabs = S.tabList();
for (const t of tabs) for (let i = 0; i < 200; i++) S.addDish(t.id, `${t.name}菜${i}`);
const dishHeavyJson = S.exportJson();
const dishHeavy = bytes(dishHeavyJson);

for (const t of tabs) {
  for (const d of S.dishesOf(t.id).slice(0, 12)) S.togglePick(d.id);
}
// 造 365 天记录：把当前导出结果补上 draws 后走真实 importJson 回写。
// （之前写的 S.__setDraw?.() 根不存在，可选链会静默返回 undefined，
//  导致"一年记录"的体积跟没有记录时一样 —— 那是个假数字）
const withDays = JSON.parse(S.exportJson());
const start = Date.parse('2026-01-01T04:00:00Z');
for (let n = 0; n < 365; n++) {
  const key = new Date(start + n * 86400000 + 8 * 3600000).toISOString().slice(0, 10);
  const byTab = {};
  for (const t of tabs) {
    const d = S.dishesOf(t.id)[n % 200];
    byTab[t.id] = { dishId: d.id, name: d.name, stars: 4, status: 'rated', at: '2026-01-01T04:00:00.000Z' };
  }
  withDays.draws[key] = byTab;
}
S.importJson(JSON.stringify(withDays));
const fullJson = S.exportJson();
const full = bytes(fullJson);

console.log('');
console.log(`8 个分类 x 200 道菜 = 1600 条      ${kb(dishHeavy)} KB`);
console.log(`再加 365 天 x 8 分类的抽签记录      ${kb(full)} KB`);
console.log(`（历史记录实际注入天数：${S.historyDesc(9999).length} 天）`);
console.log('');
console.log('对照各浏览器 localStorage 的常见额度下限 5120 KB：');
for (const [label, n] of [['空档', baseline], ['1600 道菜', dishHeavy], ['1600 道菜 + 一年记录', full]]) {
  console.log(`  ${label.padEnd(26)} 占 5MB 的 ${(n / (5 * 1024 * 1024) * 100).toFixed(2)}%`);
}

console.log('');
console.log('手动搬到另一台设备时的体积（越小越好搬）：');
sizeReport('1600 菜 + 一年记录', fullJson);
sizeReport('1600 道菜', dishHeavyJson);
S.resetToSeed();
sizeReport('空档（10 条示例）', S.exportJson());
