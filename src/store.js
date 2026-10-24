/**
 * 本地数据层：状态 + localStorage 持久化 + 全部业务规则。
 *
 * 没有后端，所以这个模块就是"数据库 + 服务层"。保留的三条规则：
 *
 *   1. 每个分类每天只抽一次：draws[day][tabId] 一旦写入就不再改。
 *      可以重抽的话，"随机到 -> 打星"就变成"我挑一个 -> 给它好评"，
 *      星级不再反映真实偏好，整套加权随机自毁。
 *   2. 只有掷中过才能打星：保持"评分 = 掷中后的真实反馈"这个语义。
 *      事后允许改星（改的是评价，不是重抽），因为口味确实会变。
 *   3. 抽中时在记录里存一份名字快照：改了名字不会篡改历史。
 *
 * ============================================================
 * 分类（tab）用 id 索引，绝不用名字
 * ============================================================
 *
 * picks 和 draws 都以 tabId 为键。如果改用名字当键，
 * 那么"给 tab 改名"这个动作会让它的候选池和历史记录瞬间失联 ——
 * 数据没被删，但再也查不出来，比删了更难排查。
 * 所以改名只动 tabs[].name，永不动 tabs[].id。
 */
import { ref, watch } from 'vue';
import { weightOf, inPool, pickWeighted, randomFloat, DEFAULT_STARS } from './weight.js';

const STORAGE_KEY = 'meal-roulette:v1';
export const MAX_PICKS = 10;
export const MAX_TABS = 8;
/* 分类名上限。标签条是横向滚动的，名字太长会把后面的分类挤出视野，
   手机上一屏最多也就显示 3-4 个字；10 个字足够表达「午饭」「公司楼下」这类名字 */
export const MAX_TAB_NAME = 10;

/** v1 数据里的固定餐别，迁移时沿用为 tab id */
const LEGACY_KEYS = ['breakfast', 'lunch', 'dinner'];
const LEGACY_LABELS = { breakfast: '早餐', lunch: '中餐', dinner: '晚餐' };

/* ------------------------------------------------------------
 * 导入数据的最小可信校验。
 * 每条规则都对应一个已复现的故障形态（见 migrate 注释），别删。
 * ------------------------------------------------------------ */
/** 只认普通对象：数组/字符串/null 按对象写入时会炸 TypeError */
const isPlainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** draws 的日期键只认 YYYY-MM-DD */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** 导入数据里的 id/键长度上限 */
const MAX_KEY_LEN = 64;

/** 新的空档：只有一个分类 */
const empty = () => ({
  v: 2,
  seq: 1,
  tabSeq: 1,
  // 默认分类直接叫「晚餐」：这个工具的主场景就是每天中午晚上发愁吃什么，
  // 与其给个中性的「默认」再让每个人手动改名，不如一步到位。
  // id 仍然是 'eat' 且刻意不改 —— picks 与 draws 都以 tabId 为键，
  // 改 id 会让所有已有候选池和历史记录失联（只是显示名换了，不影响数据）。
  tabs: [{ id: 'eat', name: '晚餐' }],
  dishes: [],
  picks: { eat: [] },
  draws: {},   // { 'YYYY-MM-DD': { [tabId]: {dishId,name,stars,status,at} } }
});

/**
 * 首次打开就给一份常见菜，免得界面是空的。可以随时删掉。
 * 恰好 10 条，与每个分类的候选上限（MAX_PICKS）对齐，
 * 这样默认状态一屏看完，不用滚动。
 */
const SEED = [
  '小笼包', '豆浆油条', '皮蛋瘦肉粥',
  '黄焖鸡米饭', '番茄鸡蛋面', '麻辣烫', '螺蛳粉', '咖喱饭',
  '红烧肉', '饺子',
];

function freshState() {
  const s = empty();
  const now = new Date().toISOString();
  for (const name of SEED) {
    s.dishes.push({ id: s.seq++, tab: 'eat', name, stars: null, createdAt: now });
  }
  return s;
}

/**
 * 把外部数据（旧版本存档、导入的 JSON）整成可信结构。
 *
 * 原则：字段级「宁丢勿放」——坏字段丢弃、好字段保留；
 * 整份读不出来时由调用方备份原串（loadState）或整体拒绝（importJson）。
 * 每一项校验都对应一个已复现的故障形态，别为了"宽容"把它们删掉：
 *
 *   tabs 非对象    → 两个 tab 的 id 都会变成 'undefined'，改名/删除全命中错对象
 *   stars 非整数   → weightOf 得 NaN、inPool 为 false，条目被静默踢出随机池
 *   draws 非对象   → draw() 对字符串属性赋值抛 TypeError，且会卡死整个 UI
 *   dish.id 非正整数 → dishById 用 === 永久查不到，"删了"其实还在
 *   seq 小于最大 id → addDish 新 id 撞车，改名/评分打错对象
 */
function migrate(parsed) {
  const s = { ...empty(), ...parsed };

  /* ---- tabs：只收普通对象；id 非空、限长、去重、排除原型链键 ---- */
  const seenIds = new Set();
  const cleanTabs = (Array.isArray(parsed.tabs) ? parsed.tabs : [])
    .filter(isPlainObj)
    .map((t) => ({ id: String(t.id ?? ''), name: String(t.name ?? '') }))
    .filter((t) => {
      if (!t.id || t.id.length > MAX_KEY_LEN) return false;
      if (t.id === '__proto__' || t.id === 'constructor' || t.id === 'prototype') return false;
      if (seenIds.has(t.id)) return false;   // 重复 id 会让 picks/draws 张冠李戴
      seenIds.add(t.id);
      return true;
    });

  if (cleanTabs.length > 0) {
    s.tabs = cleanTabs;
  } else {
    const seen = new Set(
      (Array.isArray(parsed.dishes) ? parsed.dishes : []).filter(isPlainObj).map((d) => d.tab ?? d.meal).filter(Boolean)
    );
    for (const key of Object.keys(isPlainObj(parsed.picks) ? parsed.picks : {})) seen.add(key);
    for (const byTab of Object.values(isPlainObj(parsed.draws) ? parsed.draws : {})) {
      if (isPlainObj(byTab)) for (const key of Object.keys(byTab)) seen.add(key);
    }
    // 先按固定餐别的顺序，再追加任何自定义键，保证顺序稳定可预期
    const ordered = [...LEGACY_KEYS.filter((k) => seen.has(k)), ...[...seen].filter((k) => !LEGACY_KEYS.includes(k) && k.length <= MAX_KEY_LEN && k !== '__proto__')];
    const keys = ordered.length ? ordered : ['eat'];
    s.tabs = keys.map((id) => ({ id, name: LEGACY_LABELS[id] ?? String(id) }));
    s.tabSeq = keys.length + 1;
  }

  const valid = new Set(s.tabs.map((t) => t.id));

  /* ---- dishes：id 必须是正整数且不重复；stars 只接受 null 或 0-5 整数，其余按未评 ---- */
  const dishIds = new Set();
  s.dishes = (Array.isArray(parsed.dishes) ? parsed.dishes : [])
    .filter(isPlainObj)
    .map((d) => {
      const { meal, ...rest } = d;
      const id = Number(d.id);
      if (!Number.isInteger(id) || id < 1 || dishIds.has(id)) return null;
      const tabId = d.tab ?? meal;
      const stars = d.stars == null ? null : Number(d.stars);
      return {
        ...rest,
        id,
        tab: valid.has(tabId) ? tabId : s.tabs[0].id,
        name: String(d.name ?? ''),
        stars: Number.isInteger(stars) && stars >= 0 && stars <= 5 ? stars : null,
        createdAt: String(d.createdAt ?? ''),
      };
    })
    .filter((d) => {
      if (!d) return false;
      dishIds.add(d.id);
      return true;
    });

  /* ---- picks：只保留整数条目，免得 togglePick 的 indexOf 对字符串 id 失灵 ---- */
  const picks = {};
  for (const t of s.tabs) {
    picks[t.id] = (Array.isArray(parsed.picks?.[t.id]) ? parsed.picks[t.id] : []).filter(Number.isInteger);
  }
  s.picks = picks;

  /* ---- draws：只保留 { YYYY-MM-DD: { 已知tabId: 记录 } }，其余整层丢弃 ---- */
  const draws = {};
  if (isPlainObj(parsed.draws)) {
    for (const [day, byTab] of Object.entries(parsed.draws)) {
      if (!DAY_RE.test(day) || !isPlainObj(byTab)) continue;
      const clean = {};
      for (const [tabId, rec] of Object.entries(byTab)) {
        if (!valid.has(tabId) || !isPlainObj(rec)) continue;
        const st = rec.stars == null ? null : Number(rec.stars);
        clean[tabId] = {
          dishId: Number(rec.dishId),
          name: String(rec.name ?? ''),
          stars: Number.isInteger(st) && st >= 0 && st <= 5 ? st : null,
          status: String(rec.status ?? 'pending'),
          at: String(rec.at ?? ''),
        };
      }
      draws[day] = clean;
    }
  }
  s.draws = draws;

  // seq = 下一个可用 id：导入声明的值和已有最大 id 都可能不可信，取大者
  const maxId = s.dishes.reduce((m, d) => Math.max(m, d.id), 0);
  s.seq = Math.max(Number(parsed.seq) || 0, maxId + 1);
  s.tabSeq = Math.max(Number(parsed.tabSeq) || 0, s.tabs.length + 1);
  s.v = 2;
  return s;
}

/** 坏档备份的实际键名。首次损坏用 :corrupt；再次损坏带序号，不覆盖更早的备份 */
export const corruptKeyRef = ref(null);
/** localStorage 写入失败（配额满）时为 true，App.vue 据此提示——静默吞掉等于欺骗用户 */
export const storageWarnRef = ref(false);

/**
 * 读盘。任何解析异常或结构不合预期都退回空结构，
 * 绝不让一次坏数据把整个界面卡死在白屏上。
 */
function loadState() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return { state: ref(freshState()), storageBlocked: true };
  }
  if (!raw) return { state: ref(freshState()) };

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.dishes)) throw new Error('结构不符');
    return { state: ref(migrate(parsed)) };
  } catch {
    // 坏数据留着但不覆盖：先备份一份（更早的备份不被覆盖），再开新档，原始串还能人工找回
    try {
      let key = `${STORAGE_KEY}:corrupt`;
      let n = 0;
      while (localStorage.getItem(key) !== null) key = `${STORAGE_KEY}:corrupt:${++n}`;
      localStorage.setItem(key, raw);
      corruptKeyRef.value = key;
    } catch { /* 存不下就算了 */ }
    return { state: ref(freshState()), corrupted: true };
  }
}

const { state, storageBlocked, corrupted } = loadState();
export const storageBlockedRef = storageBlocked === true;
export const corruptedRef = corrupted === true;

// 深度监听落盘，防抖 300ms：重度存档（实测 732 KB）单次全量序列化约 6.7ms，
// 连续点击时不重复序列化。写失败不再静默——静默吞掉 QuotaExceededError
// 等于"用户以为存了，关页面全丢"，比报错更糟，所以置 storageWarnRef 让界面提示。
// 页面隐藏/关闭时立即补写，避免防抖窗口内丢最后一步操作。
let writeTimer = null;
function flushWrite() {
  clearTimeout(writeTimer);
  writeTimer = null;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.value));
    storageWarnRef.value = false;
  } catch {
    storageWarnRef.value = true;
  }
}
watch(state, () => {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(flushWrite, 300);
}, { deep: true });

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', flushWrite);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushWrite();
  });
}

/* ------------------------------------------------------------
 * 日界：锁死在 UTC+8，不跟随设备时区。
 * 手机和电脑时区不一致时（出差、系统区域设置不同），
 * 若不锁定就会出现"电脑上已经抽过、手机上还能再抽一次"。
 *
 * 这里刻意不用 Intl.DateTimeFormat。用过 en-CA + timeZone:'Asia/Shanghai'，
 * 在本机两个 Node 上跑出过两种结果：Node 22 给 2026-10-24，Node 18 给 10/24/2026
 * （ICU 数据版本差异）。浏览器端同样有这个问题：不同内核/语言包会给出不同排版。
 * 这很致命，因为 day 是 draws 的主键 —— 键格式一变，"今天已经抽过"就查不到，
 * 用户能重抽，而且全程没有任何报错。
 * 中国 1991 年后无夏令时，固定 +08:00 就是精确值，
 * toISOString 永远输出 YYYY-MM-DD，不受 locale、不受运行时版本影响。
 * ------------------------------------------------------------ */
const BEIJING_OFFSET_MS = 8 * 3600_000;

/** @param {Date} [at] @returns {string} YYYY-MM-DD */
export function today(at = new Date()) {
  return new Date(at.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------
 * 分类（tab）
 * ------------------------------------------------------------ */

export function tabList() {
  return state.value.tabs;
}

export function tabById(id) {
  return state.value.tabs.find((t) => t.id === id) ?? null;
}

export function tabName(id) {
  return tabById(id)?.name ?? id;
}

/** 加一个分类。新分类进改名态由界面负责，这里只管数据。 */
export function addTab() {
  const s = state.value;
  if (s.tabs.length >= MAX_TABS) return { error: `最多建 ${MAX_TABS} 个分类` };

  // 撞 id 比"id 唯一"危险得多：picks/draws 都以 id 为键，导入存档的
  // tabSeq 与已有 tabs 不一致（手工构造/跨版本）时不查重会顶掉一个
  // 已存在分类的候选池。生成到不撞为止。
  let id;
  do { id = `t${s.tabSeq++}`; } while (s.tabs.some((t) => t.id === id) || id in s.picks);
  let n = 1;
  // 不带空格：名称输入已经限死「汉字/字母/数字」，
  // 默认名要是带空格，用户一编辑就会被过滤成另一个名字
  let name = `新分类${s.tabs.length + 1}`;
  while (s.tabs.some((t) => t.name === name)) name = `新分类${++n}`;

  const tab = { id, name };
  s.tabs.push(tab);
  s.picks[id] = [];
  return { tab };
}

export function renameTab(id, name) {
  const clean = String(name ?? '').trim();
  const tab = tabById(id);
  if (!tab) return { error: '分类不存在' };
  if (!clean) return { error: '名字不能为空' };
  if (clean.length > MAX_TAB_NAME) return { error: `名字最长 ${MAX_TAB_NAME} 个字符` };
  if (state.value.tabs.some((t) => t.name === clean && t.id !== id)) return { error: '已经有同名分类了' };
  tab.name = clean;   // 只动 name，绝不动 id
  return { tab };
}

/**
 * 删分类。有菜时需要 force，避免一次误触把整个分类的菜连带删掉。
 * 历史抽签记录（draws）刻意保留 —— 记录里存的是名字快照，
 * 菜删了历史照样能读，不需要跟着销毁。
 */
export function removeTab(id, { force = false } = {}) {
  const s = state.value;
  if (s.tabs.length <= 1) return { error: '至少要留一个分类' };

  const tab = tabById(id);
  if (!tab) return { error: '分类不存在' };

  const dishCount = s.dishes.filter((d) => d.tab === id).length;
  if (dishCount > 0 && !force) return { needsConfirm: true, dishCount, tabName: tab.name };

  s.tabs = s.tabs.filter((t) => t.id !== id);
  s.dishes = s.dishes.filter((d) => d.tab !== id);
  delete s.picks[id];
  return { removed: true, dishCount };
}

/* ------------------------------------------------------------
 * 条目库
 * ------------------------------------------------------------ */

export function dishesOf(tabId) {
  return state.value.dishes.filter((d) => d.tab === tabId);
}

/** 全量条目。迁移校验和"清空后是否为空"这类断言需要它 */
export function dishes() {
  return state.value.dishes;
}

export function dishById(id) {
  return state.value.dishes.find((d) => d.id === id) ?? null;
}

export function addDish(tabId, name) {
  const clean = String(name ?? '').trim();
  if (!clean) return { error: '名字不能为空' };
  if (clean.length > 24) return { error: '最长 24 个字符' };
  if (!tabById(tabId)) return { error: '分类不存在' };
  if (dishesOf(tabId).some((d) => d.name === clean)) return { error: '这个分类里已经有同名的了' };

  const dish = { id: state.value.seq++, tab: tabId, name: clean, stars: null, createdAt: new Date().toISOString() };
  state.value.dishes.push(dish);
  return { dish };
}

export function renameDish(id, name) {
  const clean = String(name ?? '').trim();
  const dish = dishById(id);
  if (!dish) return { error: '不存在' };
  if (!clean || clean.length > 24) return { error: '需要 1-24 个字符' };
  if (dishesOf(dish.tab).some((d) => d.name === clean && d.id !== id)) return { error: '这个分类里已经有同名的了' };
  dish.name = clean;
  return { dish };
}

/** 删条目时同时从候选池里摘掉，避免留下指向空气的 id */
export function removeDish(id) {
  const s = state.value;
  const dish = dishById(id);
  s.dishes = s.dishes.filter((d) => d.id !== id);
  if (dish && s.picks[dish.tab]) s.picks[dish.tab] = s.picks[dish.tab].filter((x) => x !== id);
}

export function setStars(id, stars) {
  const dish = dishById(id);
  if (!dish) return { error: '不存在' };
  if (!Number.isInteger(stars) || stars < 0 || stars > 5) return { error: '星级需要是 0-5 的整数' };
  dish.stars = stars;
  // 打到 0 星会让它出池；顺手从候选池摘掉，否则勾着却永远抽不到，是个死状态
  if (stars === 0) {
    const list = state.value.picks[dish.tab];
    if (Array.isArray(list)) state.value.picks[dish.tab] = list.filter((x) => x !== id);
  }
  return { dish };
}

/* ------------------------------------------------------------
 * 候选池
 * ------------------------------------------------------------ */

export function picksOf(tabId) {
  return (state.value.picks[tabId] ?? []).map(dishById).filter(Boolean);
}

/** 返回 true=加上了，false=取消了；带 error 表示被拒绝 */
export function togglePick(id) {
  const dish = dishById(id);
  if (!dish) return { error: '不存在' };
  if (!inPool(dish)) return { error: '这条打过 0 星，先给它改个星才能选' };

  const list = state.value.picks[dish.tab] ??= [];
  const i = list.indexOf(id);
  if (i >= 0) { list.splice(i, 1); return { picked: false }; }
  if (list.length >= MAX_PICKS) return { error: `每个分类最多选 ${MAX_PICKS} 条` };
  list.push(id);
  return { picked: true };
}

/* ------------------------------------------------------------
 * 抽签与记录
 * ------------------------------------------------------------ */

// tabId 不设默认值：'eat' 只是当前默认分类的 id，删掉它之后
// 省略参数的调用会静默查无此键——强制显式传参，把诱饵接口堵掉。
export function recordOf(day = today(), tabId) {
  return state.value.draws?.[day]?.[tabId] ?? null;
}

/**
 * 掷一次。已掷过就直接回历史记录，不产生新随机 ——
 * 界面重复点击、刷新、切分类都必须是幂等的。
 *
 * @param {string} tabId
 * @param {{scope?: 'picks'|'all'}} [opts]
 *   scope='picks'（默认）只从今日勾选的候选里掷；
 *   scope='all' 无视勾选，从该分类所有未出池的条目里掷。
 *   两种范围共用同一条"每天一次"记录：用任何一个掷过，今天就不能再掷。
 */
export function draw(tabId, { scope = 'picks' } = {}) {
  const day = today();
  const existed = state.value.draws?.[day]?.[tabId];
  if (existed) return { record: existed, already: true };

  const source = scope === 'all' ? dishesOf(tabId) : picksOf(tabId);
  const candidates = source.filter(inPool).map((d) => ({ dish: d, weight: weightOf(d) }));
  if (candidates.length === 0) {
    return {
      error: scope === 'all'
        ? '这个分类里还没有可掷的项（全被打成 0 星了）'
        : '候选是空的，先去右边勾选几项',
    };
  }

  const hit = pickWeighted(candidates, randomFloat());
  if (!hit) return { error: '随机失败，请重试' };

  const record = {
    dishId: hit.dish.id,
    name: hit.dish.name,   // 快照：以后改名不会篡改这条历史
    stars: null,
    status: 'pending',     // pending | rated | skipped
    at: new Date().toISOString(),
  };
  // 双保险：migrate 已保证 draws 是普通对象，这里防任何漏过 sanitize 的
  // 路径（直接改 state 的调试代码/未来新入口）把 UI 卡死在 TypeError 上
  if (!isPlainObj(state.value.draws)) state.value.draws = {};
  (state.value.draws[day] ??= {})[tabId] = record;
  return { record, already: false };
}

/** 给今天这一项打星。只能打刚掷中的那条，事后可改。 */
export function rateToday(tabId, stars) {
  const rec = recordOf(today(), tabId);
  if (!rec) return { error: '今天这个分类还没掷' };
  // 校验收到这里做：下面"条目已被删"的分支不经过 setStars，
  // 若仍依赖它校验，越界星级就会洩过去
  if (!Number.isInteger(stars) || stars < 0 || stars > 5) return { error: '星级需要是 0-5 的整数' };

  const res = setStars(rec.dishId, stars);
  if (res.error) {
    // 条目在掷出之后被删了（掷完 → 删条目 → 再打分）。
    // 记录里存着名字快照，所以这次结果仍可评分，只是不再回写条目。
    // 直接抛"不存在"会让用户对着一个已删的条目干瞪眼。
    if (dishById(rec.dishId)) return res;
    rec.stars = stars;
    rec.status = 'rated';
    return { record: rec, orphan: true };
  }
  rec.stars = stars;
  rec.status = 'rated';
  return { record: rec };
}

export function skipToday(tabId) {
  const rec = recordOf(today(), tabId);
  if (!rec) return { error: '今天这个分类还没掷' };
  rec.status = 'skipped';
  return { record: rec };
}

/* ------------------------------------------------------------
 * 排行（"自己输入的"那份榜）：按你自己的口味与被抽次数排
 * ------------------------------------------------------------ */

export function ranking(tabId) {
  const counts = new Map();
  for (const byTab of Object.values(state.value.draws ?? {})) {
    for (const rec of Object.values(byTab ?? {})) {
      if (rec?.dishId) counts.set(rec.dishId, (counts.get(rec.dishId) ?? 0) + 1);
    }
  }
  return dishesOf(tabId)
    .map((d) => ({
      ...d,
      drawn: counts.get(d.id) ?? 0,
      weight: weightOf(d),
      pooled: inPool(d),
    }))
    .sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1) || b.drawn - a.drawn || a.name.localeCompare(b.name, 'zh'));
}

/* ------------------------------------------------------------
 * 统计
 *
 * 全部从明细实时派生，不存任何聚合字段 —— 统计口径改了（比如"近 7 天"改成
 * "近 30 天"）只需改这里，不用迁移数据，也不会和历史记录不一致。
 * ------------------------------------------------------------ */

/** 两个 YYYY-MM-DD 相差几天（b 在前为正） */
function diffDays(later, earlier) {
  return Math.round((Date.parse(`${later}T00:00:00Z`) - Date.parse(`${earlier}T00:00:00Z`)) / 86400000);
}

export function stats(tabId) {
  const day = today();
  const drawsEntries = Object.entries(state.value.draws ?? {});

  // dishId -> 最近一次被掷中的日期
  const lastDay = new Map();
  for (const [d, byTab] of drawsEntries) {
    for (const rec of Object.values(byTab ?? {})) {
      if (!rec?.dishId) continue;
      const prev = lastDay.get(rec.dishId);
      if (!prev || d > prev) lastDay.set(rec.dishId, d);
    }
  }

  const dishes = dishesOf(tabId);
  const poolCount = dishes.filter(inPool).length;
  // 平均星只算真正评过分的（1-5）；0 星是"出池"信号，混进均值会把统计拉歪
  const rated = dishes.filter((d) => typeof d.stars === 'number' && d.stars > 0);
  const avgStars = rated.length ? rated.reduce((s, d) => s + d.stars, 0) / rated.length : null;
  const timesOf = (id) => drawsEntries.filter(([, byTab]) => byTab?.[id]).length;

  const oldest = [...dishes]
    .map((d) => ({
      id: d.id,
      name: d.name,
      daysAgo: lastDay.has(d.id) ? diffDays(day, lastDay.get(d.id)) : null,
    }))
    .sort((a, b) => {
      // 从未掷过的排最前；其余按"距今更久"在前
      if (a.daysAgo === null && b.daysAgo === null) return 0;
      if (a.daysAgo === null) return -1;
      if (b.daysAgo === null) return 1;
      return b.daysAgo - a.daysAgo;
    })
    .slice(0, 3);

  // 当前 tab 内每道菜被掷中的次数：draws 是 {日期: {tabId: 记录}}，
  // 一个 tab 一天只记一条，所以计数就是"被掷中的天数"。
  const drawnTimes = new Map();
  for (const [, byTab] of drawsEntries) {
    const rec = byTab?.[tabId];
    if (rec?.dishId) drawnTimes.set(rec.dishId, (drawnTimes.get(rec.dishId) ?? 0) + 1);
  }
  // 出现最多次数的前三；0 次（从没掷到过）的不进榜 —— 这是常客榜，不是全员名单
  const topDrawn = dishes
    .map((d) => ({ id: d.id, name: d.name, times: drawnTimes.get(d.id) ?? 0 }))
    .filter((d) => d.times > 0)
    .sort((a, b) => b.times - a.times)
    .slice(0, 3);

  return {
    tabName: tabName(tabId),
    tabs: tabList().length,
    dishesTotal: state.value.dishes.length,
    daysWithRecord: drawsEntries.length,
    poolCount,
    retiredCount: dishes.length - poolCount,
    avgStars,
    times: timesOf(tabId),
    recent7: drawsEntries.filter(([d, byTab]) => {
      if (!byTab?.[tabId]) return false;
      const gap = diffDays(day, d);
      return gap >= 0 && gap < 7;
    }).length,
    oldest,
    topDrawn,
  };
}

export function historyDesc(limit = 60) {
  return Object.entries(state.value.draws ?? {})
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .slice(0, limit)
    .map(([day, recs]) => ({
      day,
      items: tabList()
        .filter((t) => recs?.[t.id])
        .map((t) => ({ tab: t.id, tabName: t.name, ...recs[t.id] })),
    }));
}

/** 有记录的日期数。draws 的键数就是天数——比 historyDesc(Infinity) 全量排序便宜，
 *  给"看历史（N 天有记录）"的按钮文案用，折叠着也该有正确数字。 */
export function recordDayCount() {
  return Object.keys(state.value.draws ?? {}).length;
}

/* ------------------------------------------------------------
 * 备份 / 迁移 / 清空
 * 纯 localStorage 应用唯一的真实风险就是清浏览器数据即全没，
 * 所以导出不是锦上添花，是必备安全带（也顺带是手动跨设备的办法）。
 * ------------------------------------------------------------ */

export function exportJson() {
  return JSON.stringify({ ...state.value, exportedAt: new Date().toISOString() }, null, 2);
}

export function importJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: '文件不是合法的 JSON' };
  }
  if (!data || !Array.isArray(data.dishes)) return { error: '这个文件不是本站导出的备份' };
  if (data.dishes.length === 0 && Array.isArray(data.tabs) && data.tabs.length === 0) {
    return { error: '这个备份里没有任何分类' };
  }

  state.value = migrate(data);
  return { count: state.value.dishes.length, tabs: state.value.tabs.length };
}

export function clearAll() {
  state.value = empty();
}

export function resetToSeed() {
  state.value = freshState();
}

export { weightOf, inPool, DEFAULT_STARS };
