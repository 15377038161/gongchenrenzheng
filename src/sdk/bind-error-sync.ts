/**
 * iframe-error-sync 子页面 Vite HMR 接入。
 * import 即执行，依赖 index.html 中预先初始化的 window.__errorBridge。
 */
(() => {
  const bridge = window.__errorBridge;

  if (!import.meta.hot || !bridge) {
    return;
  }

  import.meta.hot.on('vite:beforeUpdate', () => {
    bridge.notifyHotUpdateStart?.();
  });

  import.meta.hot.on('vite:afterUpdate', () => {
    queueMicrotask(() => {
      bridge.notifyHotUpdateEnd?.();
    });
  });
})();
