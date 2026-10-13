/**
 * main.js — 启动入口
 */
(function () {
  'use strict';
  function boot() {
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
