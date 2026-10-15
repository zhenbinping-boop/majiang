/**
 * main.js — 启动入口
 *
 * 启动流程：
 *   1. 先把「主界面」（#home）亮出来 —— 它是 HTML 里静态写好的，首帧即可见，
 *      不需要等任何脚本，保证「打开就有东西看」。启动**不带任何过渡动画**。
 *   2. 背景的深绿麻将墙由 js/wall.js 铺排并持续流动（纯背景，不阻塞任何东西）。
 *   3. 用户点「开始游戏」时才真正创建对局控制器并启动（lazy，首屏零等待）；
 *      同时播放转场：整墙翻牌 → 由屏幕中心向外放大 → 交棒牌桌。
 *      点「继续上局」则复用那局控制器，只做推近、不重放翻牌。
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
   *
   * 主界面（#home）与动画层（#intro）在竖屏下也用同一套逻辑视口，
   * 故它们与 #app 一样读取 --vw/--vh（见 style.css 的竖屏媒体查询）。
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

  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function boot() {
    bindViewportVars();

    const home = $('home');
    const app = $('app');

    /** 深绿麻将墙（背景 + 翻牌转场）。铺排失败也不影响主界面可用 */
    const wall = (window.MJWall && $('hm-wall')) ? window.MJWall.init($('hm-wall')) : null;
    const ZOOM_MS = (wall && wall.TIMES) ? wall.TIMES.ZOOM_MS : 720;

    /** 对局控制器（懒创建） */
    let game = null;
    /** 主界面是否已经开过一局（用于「继续上局」的可用性） */
    let started = false;
    /** 防重入：正在切换界面 */
    let busy = false;

    /* ---------- 入口状态 ---------- */
    const btnQuick = $('btn-quick');
    const btnResume = $('btn-resume');
    const btnRules = $('home-rules');
    const btnSound = $('home-sound');
    const resumeSub = $('resume-sub');

    /** 把对局里当前局况同步到「继续上局」的副标题 */
    function syncResumeSub() {
      if (!resumeSub || !game) return;
      try {
        const e = game.engine;
        const name = (e && e.roundName) ? e.roundName : '进行中';
        const wall = (e && typeof e.wallCount === 'number')
          ? e.wallCount
          : (e && e.wall ? e.wall.length : null);
        resumeSub.textContent = name + (wall === null ? '' : ' · 牌山 ' + wall + ' 张');
      } catch (err) {
        resumeSub.textContent = '回到当前对局';
      }
    }

    /** 只要开过一局，就把「继续上局」放出来（重开一局后依然是同一个控制器） */
    function revealResume() {
      if (!btnResume || !started) return;
      syncResumeSub();
      btnResume.classList.remove('hidden');
    }

    /* ---------- 界面切换 ---------- */
    /** 主界面 → 牌桌：麻将墙翻牌并向外放大，然后交班 */
    async function enterGame(resume) {
      if (busy) return;
      busy = true;

      if (wall && !resume) {
        // 开局：整墙翻牌 → 由屏幕中心向外放大淡出
        await wall.flipAndZoom();
      } else if (home) {
        // 继续上局：不重放翻牌，只做一次推近，保持转场语言一致
        home.classList.add('entering');
        await sleep(ZOOM_MS);
      }

      if (home) home.classList.add('hidden');
      if (app) app.classList.remove('hidden');

      if (!game) {
        game = new window.MJGame.GameController();
        window.__mahjong = game; // 便于调试 / 测试
      }

      if (!resume) {
        started = true;
        // start() 内部会引擎开局 + 跑完整局循环；这里不 await，
        // 因为它直到整场打完才 resolve —— 主界面必须立刻可用。
        game.start().catch((err) => {
          console.error('对局启动失败:', err);
          const t = $('toast');
          if (t) { t.textContent = '出现错误：' + err.message; t.classList.remove('hidden'); }
        });
      }

      busy = false;
    }

    /** 牌桌 → 主界面：停掉对局，回到入口（对局对象保留，可「继续上局」） */
    function backToHome() {
      if (busy) return;
      busy = true;

      if (game) {
        game.running = false;             // 让进行中的局循环自行退出
        game._runId++;                    // 使所有在途的 runId 失效
        if (game.ui) {
          if (game.ui.cancelPendingInteractions) game.ui.cancelPendingInteractions();
          game.ui.closeModal();
          game.ui.hideActions();
        }
      }
      revealResume();

      if (app) app.classList.add('hidden');
      if (home) home.classList.remove('hidden', 'leaving');
      // 牌墙回到「牌背朝上」，下次点「开始游戏」可重放翻牌
      if (wall) wall.reset();

      busy = false;
    }
    window.__mjBackHome = backToHome;   // 供顶栏 / 结算弹窗调用

    /* ---------- 主界面交互 ---------- */
    if (btnQuick) btnQuick.addEventListener('click', () => {
      if (game && game.ui && game.ui.sound) game.ui.sound.tick();
      enterGame(false);
    });

    /* 局级（牌局规格）选择：底分决定总结算代币变动幅度 */
    const econ = window.MJEconomy || null;
    if (econ) {
      const stakePick = $('stake-pick');
      if (stakePick) {
        stakePick.addEventListener('click', (ev) => {
          const btn = ev.target.closest('.stake-btn');
          if (!btn) return;
          econ.setStake(btn.getAttribute('data-stake'));
        });
        econ.renderStakePick();
      }
      econ.maybeRelief();
      econ.renderCoins();
    }
    if (btnResume) btnResume.addEventListener('click', () => {
      if (game && game.ui && game.ui.sound) game.ui.sound.tick();
      enterGame(true);
    });
    if (btnRules) btnRules.addEventListener('click', () => {
      // 复用对局里的规则弹窗（只依赖 DOM，不需要先开局）
      if (!game) {
        game = new window.MJGame.GameController();
        window.__mahjong = game;
      }
      game.ui.showRules();
    });
    if (btnSound) btnSound.addEventListener('click', () => {
      if (!game) {
        game = new window.MJGame.GameController();
        window.__mahjong = game;
      }
      const s = game.ui.sound;
      s.muted = !s.muted;
      const ic = $('home-sound-ic'), tx = $('home-sound-tx');
      if (ic) ic.textContent = s.muted ? '🔇' : '🔊';
      if (tx) tx.textContent = s.muted ? '音效关' : '音效开';
      const topIc = $('btn-sound');
      if (topIc) {
        topIc.textContent = s.muted ? '🔇' : '🔊';
        topIc.classList.toggle('muted', s.muted);
      }
      if (!s.muted) { s.ensure(); s.tick(); }
      if (s.muted && window.speechSynthesis) {
        try { window.speechSynthesis.cancel(); } catch (e) { /* ignore */ }
      }
    });

    /* 首次交互解锁音频（浏览器策略） */
    const unlock = () => {
      if (game && game.ui) {
        const s = game.ui.sound;
        if (!s.muted) s.ensure();
      }
      document.removeEventListener('pointerdown', unlock);
    };
    document.addEventListener('pointerdown', unlock);

    /* ---------- 牌墙已由 wall.init() 铺好并开始流动，无启动动画 ---------- */

    /* 调试用 */
    window.__mjHome = { enterGame: enterGame, backToHome: backToHome, wall: wall };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
