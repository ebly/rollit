<script setup>
import { ref, computed } from 'vue';
import HomeView from './views/HomeView.vue';
import { storageBlockedRef, corruptedRef } from './store.js';

const TIP_KEY = 'meal-roulette:originTipDismissed';

function readDismissed() {
  try { return sessionStorage.getItem(TIP_KEY) === '1'; } catch { return false; }
}
const tipDismissed = ref(readDismissed());

function dismissTip() {
  try { sessionStorage.setItem(TIP_KEY, '1'); } catch { /* 存不下就只在本次生效 */ }
  tipDismissed.value = true;
}

/**
 * 来源提示。
 *
 * 纯本地存储最容易被误判成"数据丢了"的场景，就是换了打开方式：
 * 浏览器按「来源」隔离数据，file:// 、localhost 、127.0.0.1 是三个不同的桶。
 * 这件事必须在界面上说出来，否则用户只会以为网站把数据弄坏了。
 */
const originTip = computed(() => {
  if (typeof window === 'undefined') return '';
  const { protocol, hostname } = window.location;
  if (protocol === 'file:') {
    return '你现在是直接双击打开的网页（file://）。它和用 http://localhost 打开时的数据是两个独立存储，互相看不到 —— 换一种方式打开会像是"数据丢了"。想长期用，建议固定一种打开方式。';
  }
  if (hostname === '127.0.0.1') {
    return '你现在用 127.0.0.1 打开。浏览器把 127.0.0.1 和 localhost 当成两个不同来源，数据不互通。建议固定用其中一个地址。';
  }
  return '';
});
</script>

<template>
  <!-- 纯本地存储的真实故障必须显式告诉用户，
       否则他们会以为"数据没了"是网站的 bug，其实是浏览器禁写或把档清了 -->
  <div v-if="storageBlockedRef" class="warn-bar">
    这个浏览器不允许网站保存数据（隐私模式或站点设置限制），你今天的改动关掉页面就会丢。
  </div>
  <div v-else-if="corruptedRef" class="warn-bar">
    之前存的档案读不出来，已重新开始。原始数据备份在 localStorage 的
    <code>meal-roulette:v1:corrupt</code> 里，可以试试用下面的「导入」恢复。
  </div>

  <div v-if="originTip && !tipDismissed" class="warn-bar tip">
    <span>{{ originTip }}</span>
    <button class="tip-close" title="不再提示" aria-label="关闭提示" @click="dismissTip">×</button>
  </div>

  <HomeView />
</template>
