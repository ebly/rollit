import { createApp } from 'vue';
import App from './App.vue';
import './style.css';

createApp(App).mount('#app');

/**
 * 注册 Service Worker，让网站可安装到桌面、可离线打开。
 *
 * 只在生产构建里注册：
 *   - dev 下 public/sw.js 虽然能访问到，但缓存会和 Vite 的 HMR 打架，
 *     出现"改了代码页面不更新"的假故障；
 *   - 构建产物才有带 hash 的资源，缓存优先策略也只有那时才成立。
 * 注册失败不报错、不影响主流程 —— PWA 是加分项，不是运行前提。
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    // updateViaCache:'none'：检查 SW 更新时不走 HTTP 缓存。
    // 规范上浏览器拉 sw.js 本就绕过 SW 的 fetch 事件，这是廉价保险。
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => { /* 装不上就算了 */ });
  });
}
