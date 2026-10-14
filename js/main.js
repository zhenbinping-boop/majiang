/**
 * main.js — 启动入口
 */
(function () {
  'use strict';

  /**
   * 把真实视口尺寸写进 CSS 变量 --vwpx / --vhpx。
   *
   * 手机竖屏时 #app 要整屏旋转 90° 呈现横屏，旋转后它的宽高必须精确等于
   * 视口的「高」「宽」。在部分移动端 / 移动模拟环境下 100vw / 100vh 的解析
   * 与实际可视视口不一致（innerHeight 会把地址栏等算进去），所以这里统一用
   * documentElement.clientWidth/Height 取可视区，注入成 px 变量供 CSS 使用。
   */
  function bindViewportVars() {
    const apply = () => {
      const de = document.documentElement;
      de.style.setProperty('--vwpx', de.clientWidth + 'px');
      de.style.setProperty('--vhpx', de.clientHeight + 'px');
    };
    apply();
    window.addEventListener('resize', apply, { passive: true });
    window.addEventListener('orientationchange', () => setTimeout(apply, 120), { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', apply, { passive: true });
    }
  }

  function boot() {
    bindViewportVars();
    const game = new window.MJGame.GameController();
    window.__mahjong = game; // 便于调试
    game.start().catch(err => {
      console.error('对局启动失败:', err);
      const t = document.getElementById('toast');
      if (t) { t.textContent = '出现错误：' + err.message; t.classList.remove('hidden'); }
    });
    // 首次交互解锁音频（浏览器策略）
    const unlock = () => {
      const s = game.ui.sound;
      if (!s.muted) s.ensure();
      document.removeEventListener('pointerdown', unlock);
    };
    document.addEventListener('pointerdown', unlock);
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
