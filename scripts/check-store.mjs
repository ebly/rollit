/**
 * 业务规则验证：node scripts/check-store.mjs
 *
 * store.js 同时承担"数据库 + 服务层"，所以关键规则必须能脱离界面单测。
 * Vue 的 ref/watch 不依赖浏览器，只需在执行前补 localStorage 垫片。
 *
 * 本轮重点不是抽签，而是分类改成动态之后的两个真实风险：
 *   A. 改名会不会丢候选池和历史抽签记录（键如果用的是名字，一定会丢）
 *   B. 旧版固定三餐的数据能不能平滑升级（不能丢历史，也不能白屏）
 */
import { installNodeShims } from './_node-shim.mjs';

// localStorage + crypto 垫片抽到 _node-shim.mjs 共用。
// store 句柄要留着：下面换装旧版数据时要直接往里写。
const { store } = await installNodeShims();

let failed = 0;
const check = (label, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  [${extra}]` : ''}`);
};

const S = await import('../src/store.js?case=current');
const day = S.today();

console.log('=== 日界 ===');
check('日期格式恒为 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(day));
check('UTC 16:30（北京次日 00:30）归下一天', S.today(new Date('2026-10-23T16:30:00Z')) === '2026-10-24');
check('UTC 15:30（北京 23:30）归当天', S.today(new Date('2026-10-23T15:30:00Z')) === '2026-10-23');

console.log('');
console.log('=== 分类：默认只有一个 ===');
check('首次打开只有一个分类', S.tabList().length === 1, `实际 ${S.tabList().length} 个：${S.tabList().map((t) => t.name).join('/')}`);
check('默认分类下有示例条目', S.dishesOf(S.tabList()[0].id).length > 0);

const first = S.tabList()[0];

console.log('');
console.log('=== 分类：新增与改名 ===');
const t2 = S.addTab();
check('点加号能新增分类', !!t2.tab?.id && S.tabList().length === 2);
check('新分类带可编辑的默认名', typeof t2.tab?.name === 'string' && t2.tab.name.length > 0, t2.tab?.name);
check('空名被拒', S.renameTab(t2.tab.id, '   ').error !== undefined);
check('超长名被拒', S.renameTab(t2.tab.id, '一'.repeat(S.MAX_TAB_NAME + 1)).error !== undefined);
check('重名被拒', S.renameTab(t2.tab.id, first.name).error !== undefined);
check('改成合法名成功', S.renameTab(t2.tab.id, '夜宵').tab?.name === '夜宵');
check('id 不随改名变化', S.tabById(t2.tab.id)?.name === '夜宵' && S.tabById(t2.tab.id)?.id === t2.tab.id);

console.log('');
console.log('=== 核心：改名不能丢数据 ===');
const d1 = S.addDish(first.id, '回锅肉').dish;
const d2 = S.addDish(first.id, '辣子鸡').dish;
S.togglePick(d1.id);
S.togglePick(d2.id);
const rec = S.draw(first.id);
check('在新分类下能抽签', !!rec.record?.name, rec.error ?? '');
S.rateToday(first.id, 5);

const beforeName = first.name;
S.renameTab(first.id, '主餐');
check('候选池在改名后仍然存在', S.picksOf(first.id).length === 2, `还有 ${S.picksOf(first.id).length} 项`);
check('今天的抽签记录在改名后仍然查得到', S.recordOf(day, first.id)?.dishId === rec.record.dishId);
check('抽中的条目仍然能改星（记录未被改名打断）', S.rateToday(first.id, 3).record?.stars === 3);
check('tabName 反映新名字', S.tabName(first.id) === '主餐' && beforeName !== '主餐');

console.log('');
console.log('=== 分类之间互不污染 ===');
const n3 = S.addTab().tab;
const n3Dish = S.addDish(n3.id, '烤串').dish;
check('新分类候选池是空的，不继承别人的勾选', S.picksOf(n3.id).length === 0);
check('新分类今天还没掷过', S.recordOf(day, n3.id) === null);
S.togglePick(n3Dish.id);   // 不先勾进候选的话，抽签会返回"候选是空的"
const n3Draw = S.draw(n3.id);
check('新分类可以独立掷一次', !!n3Draw.record, n3Draw.error ?? '');
check('在别的分类掷过不影响本分类的判定', S.recordOf(day, n3.id)?.status === 'pending');

console.log('');
console.log('=== 分类：删除规则 ===');
check('不允许删到零个分类', (() => {
  // 先清掉除第一个以外的分类，验证"至少留一个"
  for (const t of S.tabList().filter((x) => x.id !== first.id)) S.removeTab(t.id, { force: true });
  return S.removeTab(first.id).error !== undefined && S.tabList().length === 1;
})());
const tmp = S.addTab().tab;
S.addDish(tmp.id, '待删分类里的菜');
const needConfirm = S.removeTab(tmp.id);
check('分类里有菜时必须先确认', needConfirm.needsConfirm === true && needConfirm.dishCount === 1);
check('未确认时不会真删掉', S.tabById(tmp.id) !== null);
const forced = S.removeTab(tmp.id, { force: true });
check('确认后连带删掉里面的菜', forced.removed === true && S.tabById(tmp.id) === null && S.dishesOf(tmp.id).length === 0);
check('历史抽签记录被保留（存的是名字快照）', S.recordOf(day, first.id) !== null);

console.log('');
console.log('=== 分类数量上限 ===');
check(`最多 ${S.MAX_TABS} 个分类`, (() => {
  while (S.tabList().length < S.MAX_TABS) S.addTab();
  return S.tabList().length === S.MAX_TABS && S.addTab().error !== undefined;
})());

console.log('');
console.log('=== 条目规则：上限 / 0 星联动 ===');
const only = S.tabList()[0].id;
for (let i = 0; i < 14; i++) S.addDish(only, `菜${i}`);
// 先把候选池清空：否则"取消已勾选项"也会被算成成功（它不报错），计数会虚高
for (const d of S.picksOf(only)) S.togglePick(d.id);
let added = 0;
for (const d of S.dishesOf(only)) {
  const r = S.togglePick(d.id);
  if (!r.error && r.picked) added++;
}
check(`候选上限 ${S.MAX_PICKS} 道`, added === S.MAX_PICKS && S.picksOf(only).length === S.MAX_PICKS, `勾进 ${added}`);
const victim = S.picksOf(only).find((d) => d.id !== rec.record.dishId);
const pickBefore = S.picksOf(only).length;
S.setStars(victim.id, 0);
check('打 0 星后退出随机池', S.inPool(S.dishById(victim.id)) === false);
check('打 0 星后自动从候选池摘除', S.picksOf(only).length === pickBefore - 1);
check('0 星的条目无法再被勾进候选', S.togglePick(victim.id).error !== undefined);
S.setStars(victim.id, 3);
check('改个星就能回来', S.inPool(S.dishById(victim.id)) && S.togglePick(victim.id).picked === true);

console.log('');
console.log('=== 全部随机（scope=all，无视勾选）===');
// 前面的容限测试把分类建满了，先腾出位置
for (const t of S.tabList().filter((x) => x.id !== only)) S.removeTab(t.id, { force: true });

const allTab = S.addTab().tab;
for (const n of ['甲', '乙', '丙']) S.addDish(allTab.id, n);
check('未勾选任何候选时，常规掷法会报"候选是空的"', S.draw(allTab.id).error !== undefined);

const allDraw = S.draw(allTab.id, { scope: 'all' });
check('全部随机在没有勾选时也能掷出结果', !!allDraw.record, allDraw.error ?? '');
check('掷中的项确实来自该分类', S.dishesOf(allTab.id).some((d) => d.id === allDraw.record.dishId));

const allAgain = S.draw(allTab.id, { scope: 'all' });
check('全部随机也受"每天一次"约束',
  allAgain.already === true && allAgain.record.dishId === allDraw.record.dishId);

// 全都打成 0 星时，应该给出明确提示而不是抽到个已出池的
const zeroTab = S.addTab().tab;
const zeroDish = S.addDish(zeroTab.id, '零一').dish;
S.setStars(zeroDish.id, 0);
check('分类里全是 0 星时，全部随机给出明确提示',
  (S.draw(zeroTab.id, { scope: 'all' }).error ?? '').includes('0 星'));

console.log('');
console.log('=== 统计面板 ===');
const st = S.stats(only);
check('返回分类数/条目总数等基础数字', st.tabs >= 1 && st.dishesTotal > 0 && typeof st.times === 'number');

// 关键口径：平均星只能算 1-5 星，0 星（出池信号）与未评不能混进去
const statTab = S.addTab().tab;
const fiveStar = S.addDish(statTab.id, '五星').dish;
const oneStar = S.addDish(statTab.id, '一星').dish;
const zeroStar = S.addDish(statTab.id, '零星').dish;
S.addDish(statTab.id, '未评');
S.setStars(fiveStar.id, 5);
S.setStars(oneStar.id, 1);
S.setStars(zeroStar.id, 0);
const s2 = S.stats(statTab.id);
check('4 项里可掷 3 / 已出池 1', s2.poolCount === 3 && s2.retiredCount === 1, `${s2.poolCount}/${s2.retiredCount}`);
check('平均星只算 1-5 星 => (5+1)/2 = 3.00', Math.abs(s2.avgStars - 3) < 1e-9, String(s2.avgStars));

// 最久没掷到：从未掷过的应该排最前，而不是被日期排序挤掉
const ageTab = S.addTab().tab;
const drawn = S.addDish(ageTab.id, '掷过的').dish;
S.addDish(ageTab.id, '没掷过的');
S.togglePick(drawn.id);
S.draw(ageTab.id);
const s3 = S.stats(ageTab.id);
check('最久没掷到的首项是"从未"（daysAgo 为 null）', s3.oldest[0].daysAgo === null, s3.oldest[0].name);
check('本分类掷出次数计得上', s3.times === 1, String(s3.times));

// 出现次数榜：掷过的进榜，没掷过的（0 次）不进
check('出现次数前三只收掷过的条目',
  s3.topDrawn.length === 1 && s3.topDrawn[0].name === '掷过的' && s3.topDrawn[0].times === 1,
  s3.topDrawn.map((x) => `${x.name}×${x.times}`).join(', ') || '空');

console.log('');
console.log('=== 边界：掷出后条目被删，还能评分吗 ===');
const orphanTab = S.addTab().tab;
const orphanDish = S.addDish(orphanTab.id, '掷完就删').dish;
S.togglePick(orphanDish.id);
S.draw(orphanTab.id);
S.removeDish(orphanDish.id);
const orphan = S.rateToday(orphanTab.id, 4);
check('仍能给这次结果评分，并标记 orphan',
  !orphan.error && orphan.orphan === true && orphan.record.stars === 4, orphan.error ?? '');
check('越界星级仍被拒（不再依赖 setStars 的校验）',
  S.rateToday(orphanTab.id, 9).error !== undefined);

console.log('');
console.log('=== 导出 / 导入往返 ===');
const snap = S.exportJson();
const countBefore = S.dishesOf(only).length;
const tabsBefore = S.tabList().length;
S.clearAll();
check('清空后回到单个空分类', S.tabList().length === 1 && S.dishes().length === 0);
const imp = S.importJson(snap);
check('导入恢复分类数', !imp.error && imp.tabs === tabsBefore, `${imp.tabs ?? imp.error} 个`);
check('导入恢复条目数', S.dishesOf(only).length === countBefore);
check('导入恢复当天抽签记录', S.recordOf(day, only)?.dishId === rec.record.dishId);
check('坏 JSON 被拒', S.importJson('{ 不是 json').error !== undefined);
check('非本站文件被拒', S.importJson('{"hello":1}').error !== undefined);

/* ------------------------------------------------------------
 * 旧版数据迁移（v1 固定三餐 -> v2 动态分类）
 * 用 ?case=legacy 重新求值一次模块，让它从旧档读起。
 * ------------------------------------------------------------ */
console.log('');
console.log('=== 旧版三餐数据迁移 ===');
const legacy = {
  v: 1,
  seq: 6,
  dishes: [
    { id: 1, meal: 'lunch', name: '黄焖鸡', stars: 4, createdAt: 'x' },
    { id: 2, meal: 'lunch', name: '麻辣烫', stars: null, createdAt: 'x' },
    { id: 3, meal: 'breakfast', name: '小笼包', stars: 5, createdAt: 'x' },
    { id: 4, meal: 'dinner', name: '水煮鱼', stars: 0, createdAt: 'x' },
  ],
  picks: { lunch: [1, 2], breakfast: [3], dinner: [] },
  draws: { '2026-10-22': { lunch: { dishId: 1, name: '黄焖鸡', stars: 4, status: 'rated', at: 'x' } } },
};
// 上一个模块实例的落盘是防抖的（300ms）。没等它写完就 import，
// 旧状态会在 import 的异步间隙里反过来覆盖掉塞进去的旧版数据，
// 导致"迁移测试"实际测的还是内存里的当前状态（假通过）。
// 防抖窗口是 300ms，等 400ms 确保那一次落盘已经发生。
await new Promise((r) => setTimeout(r, 400));
store.set('meal-roulette:v1', JSON.stringify(legacy));

const L = await import('../src/store.js?case=legacy');
const lunchTab = L.tabList().find((t) => t.name === '中餐');
check('按已有餐别键生成 3 个分类', L.tabList().length === 3, L.tabList().map((t) => t.name).join('/'));
check('沿用早餐/中餐/晚餐这些中文名', lunchTab !== undefined);
check('dish.meal 已迁移成 dish.tab', !!lunchTab && L.dishesOf(lunchTab.id).length === 2);
check('迁移后不再残留 meal 字段', L.dishes().every((d) => d.meal === undefined && d.tab !== undefined));
check('旧候选池原样保留', !!lunchTab && L.picksOf(lunchTab.id).length === 2);
check('昨天的历史抽签记录读得回来（没丢）',
  !!lunchTab && L.recordOf('2026-10-22', lunchTab.id)?.name === '黄焖鸡'
  && L.recordOf('2026-10-22', lunchTab.id)?.stars === 4);
check('0 星的旧条目仍在池中判定正确', L.inPool(L.dishes().find((d) => d.name === '水煮鱼')) === false);

console.log('');
console.log('=== 统计：出现次数前三 ===');
// 「每天一次」约束下没法在同一实例里跨天掷签，导入一份构造好的存档来造多日记录
const topSnap = {
  v: 2, seq: 10, tabSeq: 2,
  tabs: [{ id: 'eat', name: '晚餐' }],
  dishes: [
    { id: 1, tab: 'eat', name: '甲', stars: null, createdAt: 'x' },
    { id: 2, tab: 'eat', name: '乙', stars: null, createdAt: 'x' },
    { id: 3, tab: 'eat', name: '丙', stars: null, createdAt: 'x' },
    { id: 4, tab: 'eat', name: '丁', stars: null, createdAt: 'x' },
    { id: 5, tab: 'eat', name: '戊', stars: null, createdAt: 'x' },
    { id: 6, tab: 'eat', name: '己', stars: null, createdAt: 'x' },
  ],
  picks: { eat: [] },
  draws: {
    '2026-10-13': { eat: { dishId: 1, name: '甲', stars: null, status: 'rated', at: 'x' } },
    '2026-10-14': { eat: { dishId: 1, name: '甲', stars: null, status: 'rated', at: 'x' } },
    '2026-10-15': { eat: { dishId: 1, name: '甲', stars: null, status: 'rated', at: 'x' } },
    '2026-10-16': { eat: { dishId: 2, name: '乙', stars: null, status: 'rated', at: 'x' } },
    '2026-10-17': { eat: { dishId: 2, name: '乙', stars: null, status: 'rated', at: 'x' } },
    '2026-10-18': { eat: { dishId: 3, name: '丙', stars: null, status: 'rated', at: 'x' } },
    '2026-10-19': { eat: { dishId: 4, name: '丁', stars: null, status: 'rated', at: 'x' } },
    '2026-10-20': { eat: { dishId: 5, name: '戊', stars: null, status: 'rated', at: 'x' } },
  },
};
const topImp = S.importJson(JSON.stringify(topSnap));
check('构造存档导入成功', !topImp.error, topImp.error ?? `${topImp.tabs} 个分类`);
const stTop = S.stats('eat');
// 甲×3、乙×2 必占前二；第三名是 丙/丁/戊 之一（都 1 次，稳定排序不逐一断言）；
// 己从没掷过（0 次）不进榜，且总数封顶 3 —— 丁/戊即使掷过也挤不进榜
check('按次数降序取前三，0 次不进榜',
  stTop.topDrawn.length === 3
  && stTop.topDrawn[0].name === '甲' && stTop.topDrawn[0].times === 3
  && stTop.topDrawn[1].name === '乙' && stTop.topDrawn[1].times === 2
  && stTop.topDrawn[2].times === 1,
  stTop.topDrawn.map((x) => `${x.name}×${x.times}`).join(', '));
check('计数按天累计（甲 3 天、乙 2 天）',
  stTop.topDrawn[0].times === 3 && stTop.topDrawn[1].times === 2 && stTop.times === 8,
  `共 ${stTop.times} 天有记录`);

console.log('');
console.log('=== 病态存档 sanitize（导入加固回归）===');
// 每一条都对应一个曾复现的故障形态，防回归。
// a) tabs 为非对象数组：曾经两个 tab 的 id 都会变成 'undefined'
S.importJson(JSON.stringify({ v: 2, seq: 1, tabSeq: 1, tabs: [1, 2], dishes: [], picks: {}, draws: {} }));
check('tabs 非对象数组不产生重复 id',
  new Set(S.tabList().map((t) => t.id)).size === S.tabList().length);

// b) stars 非整数：曾经 weightOf 得 NaN、inPool 为 false，条目被静默踢出池
S.importJson(JSON.stringify({ v: 2, seq: 2, tabSeq: 1, tabs: [{ id: 'eat', name: '晚餐' }], dishes: [{ id: 1, tab: 'eat', name: '怪星', stars: 'abc', createdAt: 'x' }], picks: { eat: [] }, draws: {} }));
const weird = S.dishById(1);
check('stars 非整数按未评处理，不出池', weird && weird.stars === null && S.inPool(weird));

// c) draws 为字符串：曾经 draw() 抛 TypeError，且定时器泄漏、掷按钮永久禁用
S.importJson(JSON.stringify({ v: 2, seq: 2, tabSeq: 1, tabs: [{ id: 'eat', name: '晚餐' }], dishes: [{ id: 1, tab: 'eat', name: '甲', stars: 3, createdAt: 'x' }], picks: { eat: [1] }, draws: 'corrupted-string' }));
const afterBadDraws = S.draw('eat');
check('draws 非对象时 draw() 不抛错且能正常掷', !afterBadDraws.error && !!afterBadDraws.record);

// d) seq 小于已有最大 id：曾经 addDish 新 id 撞车，改名/评分打错对象
//    注意：dishById 返回的是响应式代理对象，不能和 addDish 的原始返回值比 ===，
//    要比行为（按 id 查得到、名字对得上）。
S.importJson(JSON.stringify({ v: 2, seq: 2, tabSeq: 1, tabs: [{ id: 'eat', name: '晚餐' }], dishes: [{ id: 1, tab: 'eat', name: '甲', stars: null, createdAt: 'x' }, { id: 100, tab: 'eat', name: '乙', stars: null, createdAt: 'x' }], picks: { eat: [] }, draws: {} }));
const fresh = S.addDish('eat', '丙').dish;
check('seq 小于最大 id 时新条目不撞车',
  fresh.id !== 1 && fresh.id !== 100 && S.dishById(fresh.id)?.name === '丙');

// e) dishes 里混 null：曾经 migrate 直接 TypeError（导入文件读不出来的元凶之一）
const nullDish = S.importJson(JSON.stringify({ v: 2, seq: 2, tabSeq: 1, tabs: [{ id: 'eat', name: '晚餐' }], dishes: [null, { id: 1, tab: 'eat', name: '甲', stars: null, createdAt: 'x' }], picks: { eat: [] }, draws: {} }));
check('dishes 含 null 不抛错，坏条目被丢弃', !nullDish.error && S.dishes().length === 1);

// f) addTab 撞已有 id：曾经直接顶掉被撞分类的候选池
S.importJson(JSON.stringify({ v: 2, seq: 3, tabSeq: 1, tabs: [{ id: 't1', name: '甲类' }], dishes: [{ id: 1, tab: 't1', name: '甲', stars: null, createdAt: 'x' }, { id: 2, tab: 't1', name: '乙', stars: null, createdAt: 'x' }], picks: { t1: [1, 2] }, draws: {} }));
const addedTab = S.addTab();
check('addTab 不撞已有 id 且不清空其候选池', !!addedTab.tab && addedTab.tab.id !== 't1' && S.picksOf('t1').length === 2);

console.log('');
console.log(failed === 0 ? '全部通过' : `有 ${failed} 项失败`);
process.exitCode = failed === 0 ? 0 : 1;
