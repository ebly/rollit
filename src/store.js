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
export const MAX_TAB_NAME = 12;

/** v1 数据里的固定餐别，迁移时沿用为 tab id */
const LEGACY_KEYS = ['breakfast', 'lunch', 'dinner'];
const LEGACY_LABELS = { breakfast: '早餐', lunch: '中餐', dinner: '晚餐' };

/** 新的空档：只有一个分类 */
const empty = () => ({
  v: 2,
  seq: 1,
  tabSeq: 1,
  // 默认分类名取中性词：这个站是通用抽签器，不该预设成"吃什么"。
  // id 仍然是 'eat' 且刻意不改 —— picks 与 draws 都以 tabId 为键，
  // 改 id 会让所有已有候选池和历史记录失联（只是显示名换了，不影响数据）。
  tabs: [{ id: 'eat', name: '默认' }],
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
 * 把 v1（固定早中晚 + dish.meal）就地升级成 v2（自定义分类 + dish.tab）。
 *
 * 关键：新 tab 直接沿用 breakfast/lunch/dinner 当 id，
 * 于是 picks 和 draws 的键【完全不用重写】，历史记录原样可读。
 * 若这里改成生成新 id，就必须同时重写 picks 与每一天的 draws，
 * 漏掉任何一处都是静默丢数据。
 */
function migrate(parsed) {
  const s = { ...empty(), ...parsed, draws: parsed.draws ?? {} };

  if (Array.isArray(parsed.tabs) && parsed.tabs.length > 0) {
    s.tabs = parsed.tabs.map((t) => ({ id: String(t.id), name: String(t.name ?? '') }));
  } else {
    const seen = new Set(
      (Array.isArray(parsed.dishes) ? parsed.dishes : []).map((d) => d.tab ?? d.meal).filter(Boolean)
    );
    for (const key of Object.keys(parsed.picks ?? {})) seen.add(key);
    for (const byTab of Object.values(parsed.draws ?? {})) {
      for (const key of Object.keys(byTab ?? {})) seen.add(key);
    }
    // 先按固定餐别的顺序，再追加任何自定义键，保证顺序稳定可预期
    const ordered = [...LEGACY_KEYS.filter((k) => seen.has(k)), ...[...seen].filter((k) => !LEGACY_KEYS.includes(k))];
    const keys = ordered.length ? ordered : ['eat'];
    s.tabs = keys.map((id) => ({ id, name: LEGACY_LABELS[id] ?? String(id) }));
    s.tabSeq = keys.length + 1;
  }

  const valid = new Set(s.tabs.map((t) => t.id));
  // 逐条把旧 meal 字段换成 tab，并删掉 meal。
  // 只改新字段不删旧字段的话，每个条目会同时带着 meal 和 tab 两份冗余数据。
  s.dishes = (Array.isArray(parsed.dishes) ? parsed.dishes : []).map((d) => {
    const { meal, ...rest } = d;
    const tabId = d.tab ?? meal;
    return { ...rest, tab: valid.has(tabId) ? tabId : s.tabs[0].id };
  });

  const picks = {};
  for (const t of s.tabs) picks[t.id] = Array.isArray(parsed.picks?.[t.id]) ? parsed.picks[t.id] : [];
  s.picks = picks;

  s.seq = Number(parsed.seq) || s.dishes.reduce((m, d) => Math.max(m, d.id), 0) + 1;
  s.tabSeq = Number(parsed.tabSeq) || s.tabs.length + 1;
  s.v = 2;
  return s;
}

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
    // 坏数据留着但不覆盖：先备份一份，再开新档，原始串还能人工找回
    try { localStorage.setItem(`${STORAGE_KEY}:corrupt`, raw); } catch { /* 存不下就算了 */ }
    return { state: ref(freshState()), corrupted: true };
  }
}

const { state, storageBlocked, corrupted } = loadState();
export const storageBlockedRef = storageBlocked === true;
export const corruptedRef = corrupted === true;

// 深度监听落盘。单人自用，数据量最多几千条，watch 的开销可以忽略；
// 真要膨胀到几万条再换节流。
watch(state, (s) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch { /* 配额满了就只在内存里用，不让界面崩 */ }
}, { deep: true });

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

  const id = `t${s.tabSeq++}`;
  let n = 1;
  let name = `新分类 ${s.tabs.length + 1}`;
  while (s.tabs.some((t) => t.name === name)) name = `新分类 ${++n}`;

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

export function recordOf(day = today(), tabId = 'eat') {
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
    perTab: tabList().map((t) => ({
      id: t.id,
      name: t.name,
      items: dishesOf(t.id).length,
      times: timesOf(t.id),
    })),
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
