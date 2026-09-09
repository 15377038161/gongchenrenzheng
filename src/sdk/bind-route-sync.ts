/**
 * iframe-route-sync 子页面接入。
 *
 * 已接入能力：
 * - 子 → 父：init() 后首屏 URL 会同步到父页面顶栏；子页面内 pushState 跳转也会自动同步
 */
import { renderHome } from '../renderer';

(() => {
  const sync = window.IframeRouteSync;

  if (!sync) {
    renderHome();
    return;
  }

  sync.child.create({ debug: false }).init();

  renderHome();
})();