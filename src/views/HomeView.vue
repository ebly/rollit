<script setup>
import { ref, computed, watch, nextTick } from 'vue';
import {
  MAX_PICKS, MAX_TABS, MAX_TAB_NAME, today,
  tabList, tabName, addTab, renameTab, removeTab,
  dishesOf, addDish, renameDish, removeDish, setStars,
  togglePick, picksOf, draw, rateToday, skipToday, recordOf,
  ranking, historyDesc, stats, exportJson, importJson, clearAll,
  inPool, DEFAULT_STARS,
} from '../store.js';
import { makeShareCode, importShareCode } from '../share.js';

const tab = ref(tabList()[0]?.id ?? '');
const error = ref('');
const notice = ref('');
const newDishName = ref('');
const renamingId = ref(null);          // 正在改名的条目
const editName = ref('');
const starsOpenId = ref(null);
const sortMode = ref('stars');         // stars | drawn | time
const spin = ref(false);
const showHistory = ref(false);
const showStats = ref(false);
const fileInput = ref(null);

// 分类
const editingTabId = ref(null);
const tabNameDraft = ref('');
/** 标记"这个输入框是刚新建出来的"，只为了提交时给出正确的提示文案 */
const createdTabId = ref(null);
// 不能用静态 ref="tabInput"：它在 v-for 里，Vue 会把收集结果变成数组，
// 导致 tabInput.value.focus() 不是函数。改用函数 ref，直接拿到当前正在编辑那一个。
const tabInputEl = ref(null);
const setTabInput = (el) => { tabInputEl.value = el; };

const tabs = computed(() => tabList());
const day = today();
const record = computed(() => recordOf(day, tab.value));
/** 某个分类今天的结果，供概览列表用（原先模板里一次渲染调了三遍 recordOf） */
const recOf = (id) => recordOf(day, id);
const pickedDishes = computed(() => picksOf(tab.value));
const pickedIds = computed(() => pickedDishes.value.map((d) => d.id));

const board = computed(() => {
  const list = ranking(tab.value);
  if (sortMode.value === 'drawn') return [...list].sort((a, b) => b.drawn - a.drawn || a.name.localeCompare(b.name, 'zh'));
  if (sortMode.value === 'time') return [...list].reverse();
  return list;
});

/** 历史默认只铺最近 30 天，点「显示更早」每次多放 30 天。
    数据层全量保留不删 —— 统计（共掷出次数、最久没掷到等）永远基于完整记录，
    展示层按需展开，两者互不影响。 */
const historyLimit = ref(30);
const history = computed(() => historyDesc(historyLimit.value));
/** 真实总天数。按钮文案和"还有多少天"都用它，不拿截断后的数量蒙人 */
const historyTotal = computed(() => historyDesc(Infinity).length);

/** 只在展开时计算：统计要看全部 draws，没必要一直算 */
const statsData = computed(() => (showStats.value ? stats(tab.value) : null));
/** 所有分类今天都已经掷过 —— 用来把「一次掷全部」置为不可点，
    否则按钮看着能点、点完只弹一句"都已掷过"，像是没反应 */
const allDrawn = computed(() => tabs.value.length > 0 && tabs.value.every((t) => recOf(t.id)));
/** 今天点了「一次掷全部」后真的会掷的分类数：没掷过 + 池子里有可掷的项。
    按钮数字用它而不是 tabs.length —— 已掷过的和空分类点了也不会出结果，
    标总数只会让人以为点了就有 N 个分类被掷。判定条件与 draw(scope:'all')
    的候选过滤一致（dishesOf(t.id).filter(inPool)），预检为真就一定能掷出。 */
const pendingCount = computed(() => tabs.value.filter(
  (t) => !recOf(t.id) && dishesOf(t.id).some(inPool),
).length);
/** 按钮文案：有得掷就报真实待掷数；没得掷时区分"都掷过了"和"根本没得掷" */
const allDrawLabel = computed(() => {
  if (pendingCount.value > 0) return `一次掷今天全部（${pendingCount.value} 个分类）`;
  return allDrawn.value ? '今天全部分类都已掷' : '没有可掷的分类（都是空的或全 0 星）';
});
/** 当前分类是否存在可掷的项（用于「全部随机」按钮的可用性） */
const hasPool = computed(() => board.value.some((d) => d.pooled));

// 删掉当前分类后，tab 会指向一个已经不存在的 id，界面会整块空掉。
// 这里兜底回第一个分类，比在删除处手工记着改更可靠。
watch(tabs, (list) => {
  if (!list.some((t) => t.id === tab.value)) {
    tab.value = list[0]?.id ?? '';
    renamingId.value = null;
    starsOpenId.value = null;
  }
});

function flash(msg, kind = 'ok') {
  notice.value = msg;
  error.value = kind === 'err' ? msg : '';
  if (kind === 'ok') setTimeout(() => { if (notice.value === msg) notice.value = ''; }, 2500);
}
function fail(msg) { notice.value = ''; error.value = msg; }

/* ---------- 应用内对话框（替代原生 confirm/prompt） ----------
   手机上原生对话框样式割裂，且 prompt 没法舒服地粘贴/编辑长分享码，
   统一换成应用内的确认/输入弹层。返回 Promise，调用处写法几乎不变。 */
const dialog = ref(null);
const dialogText = ref('');
const dialogInput = ref(null);

function askConfirm({ title, message, confirmLabel = '确定', danger = false }) {
  return new Promise((resolve) => {
    dialog.value = { kind: 'confirm', title, message, confirmLabel, danger, resolve };
  });
}
function askPrompt({ title, message, placeholder = '', confirmLabel = '确定', text = '' }) {
  dialogText.value = text;
  return new Promise((resolve) => {
    dialog.value = { kind: 'prompt', title, message, placeholder, confirmLabel, resolve };
  });
}
function closeDialog(result) {
  const d = dialog.value;
  dialog.value = null;
  dialogText.value = '';
  d?.resolve(result);
}
// 弹层打开时锁背景滚动、关闭时恢复；输入型弹层自动聚焦并全选，方便直接粘贴
watch(dialog, async (d) => {
  document.body.style.overflow = d ? 'hidden' : '';
  if (d?.kind === 'prompt') {
    await nextTick();
    dialogInput.value?.focus();
    dialogInput.value?.select?.();
  }
});

/* ---------- 分类标签 ---------- */

async function onAddTab() {
  const res = addTab();
  if (res.error) return fail(res.error);
  error.value = '';
  tab.value = res.tab.id;
  createdTabId.value = res.tab.id;   // 新建即进入改名，提交时文案要区分"新建"和"改名"
  await startTabRename(res.tab);       // 新建即进入改名态，符合"加了就想命名"的手感
}

async function startTabRename(t) {
  editingTabId.value = t.id;
  tabNameDraft.value = t.name;
  starsOpenId.value = null;
  await nextTick();
  tabInputEl.value?.focus?.();
  tabInputEl.value?.select?.();
}

function commitTabRename() {
  if (editingTabId.value === null) return;
  const wasCreated = createdTabId.value === editingTabId.value;
  const res = renameTab(editingTabId.value, tabNameDraft.value);
  if (res.error) { fail(res.error); return; }
  editingTabId.value = null;
  createdTabId.value = null;
  error.value = '';
  flash(wasCreated ? '分类已建好，以后随时能改名字' : '分类名已改，里面的候选和记录都还在');
}

function cancelTabRename() {
  editingTabId.value = null;
}

async function onRemoveTab(t) {
  const res = removeTab(t.id);
  if (res.error) return fail(res.error);
  if (res.needsConfirm) {
    // 分类里有菜，必须让用户知道删下去会连带消失多少条
    const ok = await askConfirm({
      title: `删除「${res.tabName}」？`,
      message: `里面的 ${res.dishCount} 条会一起删掉（历史抽签记录会保留）。`,
      confirmLabel: '删除', danger: true,
    });
    if (!ok) return;
    const done = removeTab(t.id, { force: true });
    if (done.error) return fail(done.error);
    flash(`已删除「${res.tabName}」及其 ${done.dishCount} 条`);
    return;
  }
  flash('分类已删除');
}

/* ---------- 列表 ---------- */

function onAdd() {
  const res = addDish(tab.value, newDishName.value);
  if (res.error) return fail(res.error);
  newDishName.value = '';
  flash(`已加入「${tabName(tab.value)}」`);
}

function startEdit(d) {
  renamingId.value = d.id;
  editName.value = d.name;
  starsOpenId.value = null;
}
function commitEdit() {
  if (renamingId.value === null) return;
  const res = renameDish(renamingId.value, editName.value);
  if (res.error) { fail(res.error); return; }
  renamingId.value = null;
  flash('已改名');
}
function cancelEdit() {
  renamingId.value = null;
}
function onRemove(d) {
  askConfirm({
    title: `删除「${d.name}」？`,
    message: '它在今日候选里会被摘掉，历史抽签记录里的名字快照保留。',
    confirmLabel: '删除', danger: true,
  }).then((ok) => {
    if (!ok) return;
    removeDish(d.id);
    if (starsOpenId.value === d.id) starsOpenId.value = null;
    if (renamingId.value === d.id) renamingId.value = null;
    flash('已删除');
  });
}
function toggleStars(d) {
  starsOpenId.value = starsOpenId.value === d.id ? null : d.id;
}
function pickStars(d, stars) {
  const res = setStars(d.id, stars);
  if (res.error) return fail(res.error);
  starsOpenId.value = null;
  flash(stars === 0 ? `「${d.name}」已退出随机池，改个星就能回来` : `已给「${d.name}」打 ${stars} 星`);
}
function clearStars(d) {
  const target = dishesOf(tab.value).find((x) => x.id === d.id);
  if (!target) return;
  target.stars = null;
  starsOpenId.value = null;
  flash(`已把「${d.name}」恢复成未评（按 ${DEFAULT_STARS} 星基准参与随机）`);
}

function onToggle(d) {
  const res = togglePick(d.id);
  if (res.error) return fail(res.error);
  error.value = '';
}

/* ---------- 抽签 ---------- */

const rollName = ref('');
let rollTimer = null;

/**
 * 滚动展示的候选名。按两种掷法各自取池：
 * 常规掷法滚的是今天勾的候选；全部随机滚的是整个分类的可用项。
 */
function poolNames(scope) {
  return scope === 'all'
    ? board.value.filter((d) => d.pooled).map((d) => d.name)
    : pickedDishes.value.map((d) => d.name);
}

function startRolling(scope = 'picks') {
  const names = poolNames(scope);
  if (!names.length) return;
  rollName.value = names[Math.floor(Math.random() * names.length)];
  rollTimer = setInterval(() => {
    rollName.value = names[Math.floor(Math.random() * names.length)];
  }, 70);
}

function stopRolling() {
  if (rollTimer) clearInterval(rollTimer);
  rollTimer = null;
  rollName.value = '';
}

/**
 * 两种掷法共用这一套：动画、纠错、幂等完全一样，
 * 差别只在交给 draw() 的 scope。
 */
async function runDraw(scope = 'picks') {
  if (record.value) return flash('这个分类今天已经掷过了');
  spin.value = true;
  startRolling(scope);
  // 本地 draw() 是同步的，会一闪而过，所以先让动画跑满一段固定时长。
  await new Promise((r) => setTimeout(r, 620));
  const res = draw(tab.value, { scope });
  stopRolling();
  spin.value = false;
  if (res.error) return fail(res.error);
  if (res.already) flash('这个分类今天已经掷过了');
}

const onDraw = () => runDraw('picks');
/** 不看勾选，从整个分类的所有可用项里掷 */
const onDrawEvery = () => runDraw('all');

function onRate(stars) {
  const res = rateToday(tab.value, stars);
  if (res.error) return fail(res.error);
  if (res.orphan) return flash(`已评 ${stars} 星（这条已被删除，分数只记在这次历史里）`);
  flash(stars === 0 ? '打了 0 星，这条已退出随机池' : `已评 ${stars} 星`);
}

function onSkip() {
  const res = skipToday(tab.value);
  if (res.error) return fail(res.error);
  flash('已跳过，没有评分');
}

/**
 * 一次掷今天全部：对每个「今天还能掷」的分类各掷一次，一律走全部随机
 * （无视勾选，从整个分类的可用项里抽）。
 * 已经掷过的分类直接跳过 —— 不重复掷、不当失败；
 * 没有可掷项的（空分类或全 0 星）也跳过 —— 预检条件和按钮上的 pendingCount
 * 是同一个，用户点之前就从数字上知道有几个分类会响应。
 * 掷完自动切到第一个新掷出的分类，否则用户看不到任何结果。
 */
function onDrawAll() {
  error.value = '';
  const drawn = [];
  let firstNew = null;
  for (const t of tabs.value) {
    if (recOf(t.id)) continue;                    // 抛过的就不管
    if (!dishesOf(t.id).some(inPool)) continue;   // 空分类/全 0 星：没得掷，不当失败
    const res = draw(t.id, { scope: 'all' });     // 全部随机：不看勾选
    if (res.error) return fail(res.error);        // 预检通过还出错只可能是随机故障，直接报
    if (res.already) continue;                    // 防御：上面已按今日记录跳过，理论上到不了
    drawn.push(t.name);
    firstNew = firstNew ?? t.id;
  }
  if (firstNew) tab.value = firstNew;
  flash(drawn.length ? `已掷：${drawn.join('、')}` : '没有可掷的分类（都是空的或全被打成 0 星）');
}

/* ---------- 备份 ---------- */

function onExport() {
  const blob = new Blob([exportJson()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `掷一个-${day}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  flash('已导出备份文件');
}
function onImportClick() {
  fileInput.value?.click();
}

async function onImportFile(ev) {
  const file = ev.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  const res = importJson(text);
  ev.target.value = '';
  if (res.error) return fail(res.error);
  flash(`已导入：${res.tabs} 个分类、${res.count} 条，当前数据被这个文件覆盖`);
}
/* ---------- 分享码 ---------- */

/**
 * 生成分享码。优先写剪贴板，失败就弹框让用户自己拷 ——
 * file:// 下 navigator.clipboard 不可用（非安全上下文），必须有降级。
 */
async function onShare() {
  try {
    const code = await makeShareCode(tab.value);
    let copied = false;
    try {
      await navigator.clipboard.writeText(code);
      copied = true;
    } catch { copied = false; }
    if (copied) flash(`分享码已复制（${code.length} 字符），粘给对方就行`);
    else {
      // 剪贴板不可用（如 file:// 非安全上下文）：弹出一个可全选复制的小窗
      await askPrompt({
        title: '复制这段分享码',
        message: '剪贴板不可用，已全选下面的内容，复制后发给对方：',
        text: code, confirmLabel: '复制好了',
      });
    }
  } catch (e) {
    fail(e.message);
  }
}

/** 导入分享码：新增一个分类，不碰现有数据 */
async function onImportCode() {
  const code = await askPrompt({
    title: '粘贴导入分享码',
    message: '把对方给的分享码粘到下面。导入后会新建一个分类，不影响你现有的数据。',
    placeholder: 'ZYD1:...',
    confirmLabel: '导入',
  });
  if (!code || !code.trim()) return;
  try {
    const res = await importShareCode(code.trim());
    tab.value = tabList().at(-1)?.id ?? tab.value;
    flash(`已导入「${res.tabName}」 ${res.count} 项${res.skipped ? `（跳过 ${res.skipped} 项重名）` : ''}`);
  } catch (e) {
    fail(e.message);
  }
}

async function onClear() {
  const ok = await askConfirm({
    title: '清空数据？',
    message: '所有分类、条目和历史记录都会被删掉，这一步不能撤销。建议先导出备份。',
    confirmLabel: '清空', danger: true,
  });
  if (!ok) return;
  clearAll();
  tab.value = tabList()[0]?.id ?? '';
  flash('已清空，只剩一个空分类');
}
</script>

<template>
  <header class="topbar">
    <strong>掷一个</strong>
    <span class="muted">{{ day }}</span>
    <div class="topbar-actions">
      <button @click="onExport">导出</button>
      <button @click="onImportClick">导入</button>
      <button class="btn-danger" @click="onClear">清空数据</button>
      <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="onImportFile" />
    </div>
  </header>

  <nav class="meal-tabs">
    <div v-for="t in tabs" :key="t.id" class="tab" :class="{ on: tab === t.id }">
      <template v-if="editingTabId === t.id">
        <input
          :ref="setTabInput" class="tab-edit" v-model="tabNameDraft"
          :maxlength="MAX_TAB_NAME"
          @keyup.enter="commitTabRename" @keyup.esc="cancelTabRename" @blur="commitTabRename"
        />
      </template>
      <template v-else>
        <button class="tab-label" @click="tab = t.id">{{ t.name }}</button>
        <!-- 与菜谱行的改名按钮同款 SVG 图标：字符 ✎ 是文字字形，
             和 emoji/文本混排时大小不可控，SVG 固定尺寸且继承 currentColor -->
        <button class="tab-act" v-if="tab === t.id" title="改这个名字" aria-label="改分类名" @click="startTabRename(t)">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
               stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
          </svg>
        </button>
        <button class="tab-act" v-if="tab === t.id && tabs.length > 1" title="删除这个分类" aria-label="删除这个分类" @click="onRemoveTab(t)">×</button>
      </template>
    </div>

    <button class="tab-add" v-if="tabs.length < MAX_TABS" title="新建一个分类" aria-label="新建分类" @click="onAddTab">＋</button>
    <span class="muted tab-limit" v-else>最多 {{ MAX_TABS }} 个</span>
  </nav>

  <main class="layout">
    <!-- ================= 左：抽签 ================= -->
    <section class="card">
      <div class="panel-title"><h2>今日概览</h2></div>
      <ul class="today-list">
        <li v-for="t in tabs" :key="t.id"
            :class="{ done: recOf(t.id)?.status === 'rated',
                      pending: recOf(t.id) && recOf(t.id).status !== 'rated',
                      now: tab === t.id }"
            @click="tab = t.id">
          <span class="tl-name">{{ t.name }}</span>
          <span class="tl-dish">{{ recOf(t.id)?.name ?? '还没掷' }}</span>
          <span class="tl-flag" v-if="recOf(t.id)?.status === 'rated'">★{{ recOf(t.id).stars }}</span>
          <span class="tl-flag skip" v-else-if="recOf(t.id)?.status === 'skipped'">跳过</span>
        </li>
      </ul>

      <!-- 今天已经掷过就整块隐藏：候选清单、计数、两个掷按钮都已失去意义，
           留着只会是一块灰色死区。想看/改候选明天再来，或先清空今日记录。 -->
      <template v-if="!record">
      <div class="panel-title" style="margin-top: 18px">
        <h2>今天想从哪几项里掷</h2>
        <span class="muted">{{ pickedIds.length }}/{{ MAX_PICKS }}</span>
      </div>
      <ul class="pick-list" v-if="pickedDishes.length">
        <li v-for="d in pickedDishes" :key="d.id">
          {{ d.name }}<span class="star-mini" v-if="d.stars">★{{ d.stars }}</span>
          <button @click="onToggle(d)" title="移除" aria-label="从候选移除">×</button>
        </li>
      </ul>
      <p class="muted" v-else>右边还没勾，先点几项前面的方框。</p>

      <div class="draw-row">
        <!-- 不看今日勾选，直接从整个分类的可用项里掷；
             与右侧共用每日一次记录，用哪个掷过今天都不能再掷 -->
        <button class="draw-alt" :disabled="!!record || !hasPool || spin" @click="onDrawEvery"
                title="不看勾选，从这个分类的全部条目里掷一个">
          全部随机
        </button>
        <button class="draw-btn" :disabled="!!record || !pickedIds.length || spin" @click="onDraw">
          <template v-if="record">这个分类今天已掷</template>
          <template v-else-if="!pickedIds.length">先勾选几项</template>
          <template v-else-if="spin">掷取中…</template>
          <template v-else>掷一个</template>
        </button>
      </div>
      </template>
      <!-- 每个今天还能掷的分类各掷一个，一律全部随机（不看勾选）；
           括号里的数字是真实待掷数，已掷过的和空分类不计入 -->
      <button class="link all-draw" v-if="tabs.length > 1" :disabled="pendingCount === 0" @click="onDrawAll"
              title="每个今天还没掷过、且有可掷项的分类各掷一个（全部随机，不看勾选）；已经掷过的和空分类跳过">
        {{ allDrawLabel }}
      </button>

      <div class="result" :class="{ has: record, rolling: spin }">
        <template v-if="spin">
          <div class="dish-name">{{ rollName || '…' }}</div>
          <span class="muted">正在捞…</span>
        </template>
        <template v-else-if="!record">
          <span class="empty">结果会出现在这里</span>
          <span class="muted">每个分类每天只能掷一次，掷完不能重掷</span>
        </template>
        <template v-else>
          <div class="dish-name">{{ record.name }}</div>

          <template v-if="record.status === 'pending'">
            <div class="rate-row">
              <button v-for="s in 5" :key="s" class="rate-star" @click="onRate(s)">★{{ s }}</button>
              <button class="rate-zero" @click="onRate(0)">0 星 · 别再掷到</button>
            </div>
            <button class="link" @click="onSkip">今天没选它，跳过不评</button>
          </template>

          <template v-else-if="record.status === 'rated'">
            <div class="stars readonly">
              <span v-for="s in 5" :key="s" :class="{ on: s <= record.stars }">★</span>
            </div>
            <div class="rate-row compact">
              <span class="muted">改主意了？</span>
              <button v-for="s in 5" :key="`e${s}`" class="rate-star sm" @click="onRate(s)">{{ s }}</button>
              <button class="rate-zero sm" aria-label="打 0 星，别再掷到" @click="onRate(0)">0</button>
            </div>
          </template>

          <template v-else>
            <span class="muted">这一项跳过了评分</span>
            <div class="rate-row compact">
              <button v-for="s in 5" :key="`a${s}`" class="rate-star sm" @click="onRate(s)">评 ★{{ s }}</button>
            </div>
          </template>
        </template>
      </div>

      <p class="error" v-if="error">{{ error }}</p>
      <p class="ok" v-if="notice">{{ notice }}</p>

      <div class="link-row" style="margin-top: 12px">
        <button class="link" @click="showHistory = !showHistory">
          {{ showHistory ? '收起记录' : `看历史（${historyTotal} 天有记录）` }}
        </button>
        <button class="link" @click="showStats = !showStats">
          {{ showStats ? '收起统计' : '看统计' }}
        </button>
      </div>
      <div v-if="showHistory" class="history">
        <div v-for="h in history" :key="h.day" class="history-day">
          <span class="history-date">{{ h.day }}</span>
          <span v-for="it in h.items" :key="it.tab" class="history-item">
            {{ it.tabName }}·{{ it.name }}<b v-if="it.stars !== null && it.stars !== undefined">★{{ it.stars }}</b>
            <i v-if="it.status === 'skipped'">跳</i>
          </span>
        </div>
        <p class="muted" v-if="!history.length">还没有抽签记录。</p>
        <template v-else>
          <button class="link" style="margin-top: 6px" v-if="history.length < historyTotal"
                  @click="historyLimit += 30">
            显示更早的 30 天（还有 {{ historyTotal - history.length }} 天）
          </button>
          <p class="muted" v-else>已经到底，没有更早的记录了</p>
        </template>
      </div>

      <div v-if="statsData" class="stats">
        <div class="stat-row">
          <span>「{{ statsData.tabName }}」可掷 / 已出池</span>
          <b>{{ statsData.poolCount }} / {{ statsData.retiredCount }}</b>
        </div>
        <div class="stat-row">
          <span>「{{ statsData.tabName }}」共掷出</span>
          <b>{{ statsData.times }} 次<span class="muted">（近 7 天 {{ statsData.recent7 }}）</span></b>
        </div>
        <div class="stat-row">
          <span>「{{ statsData.tabName }}」平均星级</span>
          <b>{{ statsData.avgStars === null ? '还没有评分' : statsData.avgStars.toFixed(2) }}</b>
        </div>

        <div class="stat-block">
          <span class="muted">最久没掷到的</span>
          <div class="oldest" v-if="statsData.oldest.length">
            <span v-for="o in statsData.oldest" :key="o.id" class="history-item">
              {{ o.name }}<b>{{ o.daysAgo === null ? '从未' : `${o.daysAgo} 天` }}</b>
            </span>
          </div>
          <span class="muted" v-else>这个分类还没有条目。</span>
        </div>

        <!-- 出现最多次数的前三：只列掷过的，0 次不进榜；整个 tab 还没掷过时给一句兜底 -->
        <div class="stat-block">
          <span class="muted">「{{ statsData.tabName }}」出现最多次的</span>
          <div class="oldest" v-if="statsData.topDrawn.length">
            <span v-for="t in statsData.topDrawn" :key="t.id" class="history-item">
              {{ t.name }}<b>{{ t.times }} 次</b>
            </span>
          </div>
          <span class="muted" v-else>这个分类还没掷过</span>
        </div>
      </div>
    </section>

    <!-- ================= 右：清单 ================= -->
    <section class="card">
      <div class="panel-title">
        <h2>清单</h2>
        <div class="sort-switch">
          <button :class="{ on: sortMode === 'stars' }" @click="sortMode = 'stars'">按星级</button>
          <button :class="{ on: sortMode === 'drawn' }" @click="sortMode = 'drawn'">按选中次数</button>
          <button :class="{ on: sortMode === 'time' }" @click="sortMode = 'time'">最新加的</button>
        </div>
      </div>

      <div class="add-row">
        <input v-model="newDishName" maxlength="24" placeholder="加一项" @keyup.enter="onAdd" />
        <button class="btn-primary" @click="onAdd">加入</button>
      </div>

      <div v-for="(d, i) in board" :key="d.id" class="dish-wrap"
           :class="{ picked: pickedIds.includes(d.id), out: !d.pooled }">
        <div class="dish-row">
          <input type="checkbox" :id="`p${d.id}`" :checked="pickedIds.includes(d.id)"
                 :disabled="!d.pooled" @change="onToggle(d)" />
          <span class="rank">{{ i + 1 }}</span>

          <template v-if="renamingId === d.id">
            <input class="edit-input" v-model="editName" maxlength="24"
                   @keyup.enter="commitEdit" @keyup.esc="cancelEdit" />
            <button class="sm" @click="commitEdit">存</button>
            <button class="sm" @click="cancelEdit">取消</button>
          </template>
          <template v-else>
            <label class="name" :for="`p${d.id}`">{{ d.name }}</label>
          </template>

          <!-- 分支顺序很关键：!d.pooled 必须先判。
               之前把 d.stars !== null 写在第一位，而 0 星不是 null，
               于是出池的条目渲染成「★0」，「已退出随机」标签连同 .tag.out
               样式永远不可达。 -->
          <button class="tag out clickable" v-if="!d.pooled" @click="toggleStars(d)">已退出随机</button>
          <button class="tag lit clickable" v-else-if="d.stars !== null" @click="toggleStars(d)">★{{ d.stars }}</button>
          <button class="tag clickable" v-else @click="toggleStars(d)">未评</button>

          <span class="meta">选中 {{ d.drawn }}</span>

          <div class="row-actions">
            <!-- 图标用内联 SVG 而非字符：✎ 是文字字形、🗑 是 emoji，
                 两者走完全不同的渲染通道，字号永远对不齐（手机上一个小一个大）。
                 SVG 固定 20×20 且继承 currentColor，任何设备等大、随配色变量变色。 -->
            <button @click="startEdit(d)" title="改名" aria-label="改名">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
                   stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
              </svg>
            </button>
            <button class="danger" @click="onRemove(d)" title="删除" aria-label="删除条目">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
                   stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M10 11v6M14 11v6" />
              </svg>
            </button>
          </div>
        </div>

        <div class="star-editor" v-if="starsOpenId === d.id">
          <span class="muted">星越高越容易被掷到：</span>
          <button v-for="s in 5" :key="`s${s}`" class="rate-star sm" @click="pickStars(d, s)">★{{ s }}</button>
          <button class="rate-zero sm" aria-label="打 0 星，退出随机池" @click="pickStars(d, 0)">0</button>
          <button class="link" @click="clearStars(d)">清除评分</button>
        </div>
      </div>

      <div class="share-row">
        <button class="link" @click="onShare">分享本分类</button>
        <button class="link" @click="onImportCode">粘贴导入分享码</button>
      </div>

      <p class="muted legend">
        点前方框加入今日候选；点★或「未评」改星；星越高越容易被掷到，
        打 0 星就退出随机池（改成任意星即可恢复）。标签上的 ✎ 用来改分类名，
        候选池和历史记录都不会丢。
      </p>

      <div class="dish-row empty" v-if="!board.length">
        <span class="muted">这个分类还是空的，先在上面加几项。</span>
      </div>
    </section>
  </main>

  <!-- 应用内对话框：确认型用按钮，输入型用多行文本框；点遮罩或按 Esc 取消 -->
  <div class="modal-mask" v-if="dialog" @click.self="closeDialog(dialog.kind === 'confirm' ? false : null)">
    <div class="modal" role="alertdialog" :aria-label="dialog.title"
         @keydown.esc="closeDialog(dialog.kind === 'confirm' ? false : null)">
      <h3 class="modal-title">{{ dialog.title }}</h3>
      <p class="modal-msg">{{ dialog.message }}</p>
      <textarea v-if="dialog.kind === 'prompt'" ref="dialogInput" v-model="dialogText"
                class="modal-input" :placeholder="dialog.placeholder"></textarea>
      <div class="modal-actions">
        <button class="link" @click="closeDialog(dialog.kind === 'confirm' ? false : null)">取消</button>
        <button :class="dialog.danger ? 'btn-danger' : 'btn-primary'"
                @click="closeDialog(dialog.kind === 'confirm' ? true : dialogText.value)">
          {{ dialog.confirmLabel }}
        </button>
      </div>
    </div>
  </div>
</template>
