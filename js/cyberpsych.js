/* Nightboard '83 — Cyberpsychosis Danger (doomscroll detector)
   Copyright (C) 2026 Ralf Wissing
   SPDX-License-Identifier: AGPL-3.0-or-later

   Tracks scroll velocity, session duration, post-consumption rate,
   and time of day to estimate a "humanity" score. When it drops,
   escalating CRT-glitch warnings fire — themed as cyberpsychosis risk.

   Self-contained: no deps, hooks into existing .col-body scroll containers
   via MutationObserver. Exposes window.NBCyberpsych.
*/
(function (root) {
  "use strict";

  const LS_KEY = "nightboard83.cyberpsych";
  const SCROLL_SELECTORS = ".col-body, .col-scroll, [data-col-body]";
  const POST_SELECTORS = "article.status, article[data-status-id], .status-card";
  const TICK_MS = 4000;           // humanity engine tick (slower, less twitchy)
  const SCROLL_WINDOW_MS = 60000; // velocity rolling window
  const PAUSE_THRESHOLD_MS = 3000; // gap that ends an "active" burst
  const RECOVERY_PAUSE_MS = 8000; // pause long enough to start recovery (faster recovery)
  const RECOVERY_FULL_MS = 90000; // pause that fully restores humanity (faster full recovery)
  const FAST_POST_MS = 1500;      // post visible < this = "skimmed"
  const NIGHT_START = 22;         // hour
  const NIGHT_END = 5;

  // Decay rates (humanity points per tick) by signal contribution.
  // Halved from original for a gentler, less aggressive response.
  const DECAY = {
    velocity: 0.22,
    continuous: 0.15,
    skimRate: 0.18,
    session: 0.08,
  };
  const RECOVER_PER_TICK = 4.0;
  const NIGHT_MULT = 1.3;

  // --- State ---
  let humanity = 100;
  let level = 0;
  let enabled = true;
  let tickTimer = null;
  let observer = null;
  let io = null;
  let sessionStart = 0;
  let lastScrollTs = 0;
  let lastScrollY = 0;
  let scrollSamples = [];
  let activeBurstStart = 0;
  let skimmedCount = 0;
  let postTimers = new Map();
  let hudEl = null;
  let barEl = null;
  let labelEl = null;
  let pctEl = null;
  let warnEl = null;
  let warnTitleEl = null;
  let warnMsgEl = null;
  let dismissBtnEl = null;
  let ackBtnEl = null;
  let glitchEl = null;
  let dismissTimer = null;
  let reducedMotion = false;
  let persist = false;

  function load() {
    if (!persist) return;
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const d = JSON.parse(raw);
        humanity = typeof d.humanity === "number" ? d.humanity : 100;
      }
    } catch {}
  }

  function save() {
    if (!persist) return;
    try { localStorage.setItem(LS_KEY, JSON.stringify({ humanity })); } catch {}
  }

  function t(key, vars) {
    try {
      if (root.NBI18n && typeof root.NBI18n.t === "function")
        return root.NBI18n.t(key, vars);
    } catch {}
    return key;
  }

  const LEVELS = [
    { min: 80, name: "stable",     color: "var(--mint)",   cls: "cp-stable" },
    { min: 60, name: "elevated",   color: "var(--yellow)", cls: "cp-elevated" },
    { min: 40, name: "unstable",   color: "var(--orange)", cls: "cp-unstable" },
    { min: 20, name: "critical",   color: "var(--red)",    cls: "cp-critical" },
    { min: 0,  name: "cyberpsych", color: "var(--red)",    cls: "cp-cyberpsych" },
  ];

  function levelFor(h) {
    for (let i = 0; i < LEVELS.length; i++)
      if (h >= LEVELS[i].min) return i;
    return LEVELS.length - 1;
  }

  function isNight() {
    const h = new Date().getHours();
    return h >= NIGHT_START || h < NIGHT_END;
  }

  // --- Scroll tracking ---
  function onScroll(ev) {
    const now = Date.now();
    const el = ev.target;
    const y = el.scrollTop;
    const delta = Math.abs(y - lastScrollY);
    lastScrollY = y;
    if (delta > 2) {
      scrollSamples.push({ ts: now, delta });
      const cutoff = now - SCROLL_WINDOW_MS;
      while (scrollSamples.length && scrollSamples[0].ts < cutoff)
        scrollSamples.shift();
      if (!activeBurstStart) activeBurstStart = now;
      lastScrollTs = now;
    }
  }

  function velocityPxPerMin() {
    if (!scrollSamples.length) return 0;
    const span = Math.max(1000, scrollSamples[scrollSamples.length - 1].ts - scrollSamples[0].ts);
    const total = scrollSamples.reduce((s, x) => s + x.delta, 0);
    return (total / span) * 60000;
  }

  function activeBurstMs(now) {
    return activeBurstStart ? now - activeBurstStart : 0;
  }

  function sessionMs(now) {
    return now - sessionStart;
  }

  // --- Post skimming via IntersectionObserver ---
  function onPostVisible(entries) {
    for (const e of entries) {
      if (!e.isIntersecting) {
        const timer = postTimers.get(e.target);
        if (timer) {
          clearTimeout(timer);
          postTimers.delete(e.target);
          skimmedCount++;
        }
        continue;
      }
      const timer = setTimeout(() => {
        postTimers.delete(e.target);
      }, FAST_POST_MS);
      postTimers.set(e.target, timer);
    }
  }

  // --- Humanity engine ---
  function tick() {
    if (!enabled) return;
    const now = Date.now();
    const gap = now - lastScrollTs;

    if (gap > RECOVERY_PAUSE_MS) {
      const pauseMs = gap;
      if (pauseMs >= RECOVERY_FULL_MS) {
        humanity = 100;
      } else {
        humanity = Math.min(100, humanity + RECOVER_PER_TICK);
      }
      activeBurstStart = 0;
      skimmedCount = 0;
      sessionStart = now;
    } else {
      const vel = velocityPxPerMin();
      const burst = activeBurstMs(now);
      const sess = sessionMs(now);
      let decay = 0;

      if (vel > 3000) decay += DECAY.velocity * Math.min(3, vel / 6000);
      if (burst > 45000) decay += DECAY.continuous * Math.min(2, burst / 90000);
      if (skimmedCount > 8) decay += DECAY.skimRate * Math.min(3, skimmedCount / 15);
      skimmedCount = 0;
      if (sess > 420000) decay += DECAY.session * Math.min(2, sess / 840000);
      if (isNight()) decay *= NIGHT_MULT;

      humanity = Math.max(0, humanity - decay);
    }

    save();
    const newLevel = levelFor(humanity);
    if (newLevel !== level) {
      const worsening = newLevel > level;
      level = newLevel;
      onLevelChange(worsening);
    }
    paintHUD();
  }

  // --- HUD ---
  function buildHUD() {
    if (hudEl) return;

    hudEl = document.createElement("div");
    hudEl.className = "cp-hud";
    hudEl.setAttribute("role", "status");
    hudEl.setAttribute("aria-live", "polite");
    hudEl.hidden = true;
    hudEl.innerHTML =
      '<div class="cp-hud-inner">' +
        '<div class="cp-hud-label" data-cp-label>HUMANITY</div>' +
        '<div class="cp-hud-bar-track">' +
          '<div class="cp-hud-bar-fill" data-cp-bar></div>' +
        '</div>' +
        '<div class="cp-hud-pct" data-cp-pct>100%</div>' +
      '</div>';
    var mount = document.getElementById("cp-bar-mount");
    (mount || document.body).appendChild(hudEl);

    warnEl = document.createElement("div");
    warnEl.className = "cp-warn-overlay";
    warnEl.hidden = true;
    warnEl.innerHTML =
      '<div class="cp-warn-box">' +
        '<div class="cp-warn-icon" aria-hidden="true">\u26A0</div>' +
        '<h2 class="cp-warn-title" data-cp-warn-title></h2>' +
        '<p class="cp-warn-msg" data-cp-warn-msg></p>' +
        '<div class="cp-warn-actions">' +
          '<button type="button" class="cp-warn-btn" data-cp-dismiss></button>' +
          '<button type="button" class="cp-warn-btn cp-warn-btn-ghost" data-cp-acknowledge></button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(warnEl);

    glitchEl = document.createElement("div");
    glitchEl.className = "cp-glitch";
    glitchEl.setAttribute("aria-hidden", "true");
    glitchEl.hidden = true;
    document.body.appendChild(glitchEl);

    warnEl.querySelector("[data-cp-dismiss]").addEventListener("click", dismissWarn);
    warnEl.querySelector("[data-cp-acknowledge]").addEventListener("click", acknowledgeWarn);

    barEl = hudEl.querySelector("[data-cp-bar]");
    labelEl = hudEl.querySelector("[data-cp-label]");
    pctEl = hudEl.querySelector("[data-cp-pct]");
    warnTitleEl = warnEl.querySelector("[data-cp-warn-title]");
    warnMsgEl = warnEl.querySelector("[data-cp-warn-msg]");
    dismissBtnEl = warnEl.querySelector("[data-cp-dismiss]");
    ackBtnEl = warnEl.querySelector("[data-cp-acknowledge]");
  }

  function paintHUD() {
    if (!hudEl) return;
    const lv = LEVELS[level];
    const pct = Math.round(humanity);
    hudEl.hidden = false;
    barEl.style.width = pct + "%";
    barEl.style.background = lv.color;
    barEl.style.boxShadow = "0 0 12px " + lv.color;
    labelEl.textContent = t("cyberpsych.level." + lv.name);
    pctEl.textContent = pct + "%";
    hudEl.className = "cp-hud " + lv.cls;
  }

  function onLevelChange(worsening) {
    if (glitchEl) {
      glitchEl.hidden = level < 2;
      glitchEl.className = "cp-glitch cp-glitch-l" + level;
    }

    document.body.classList.remove("cp-l0", "cp-l1", "cp-l2", "cp-l3", "cp-l4");
    document.body.classList.add("cp-l" + level);

    if (level >= 2 && worsening && warnEl) {
      showWarn();
    } else if (warnEl) {
      warnEl.hidden = true;
    }

    if (level === 0) {
      if (warnEl) warnEl.hidden = true;
      if (glitchEl) glitchEl.hidden = true;
      document.body.classList.remove("cp-l0", "cp-l1", "cp-l2", "cp-l3", "cp-l4");
    }
  }

  function showWarn() {
    if (!warnEl || !warnEl.hidden) return;
    const lv = LEVELS[level];
    warnTitleEl.textContent = t("cyberpsych.warn." + lv.name + ".title");
    warnMsgEl.textContent = t("cyberpsych.warn." + lv.name + ".msg");
    dismissBtnEl.textContent = t("cyberpsych.dismiss");
    ackBtnEl.textContent = t("cyberpsych.acknowledge");
    warnEl.hidden = false;

    if (dismissTimer) clearTimeout(dismissTimer);
    if (level < 4) dismissTimer = setTimeout(dismissWarn, 12000);
  }

  function dismissWarn() {
    if (warnEl) warnEl.hidden = true;
    if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
  }

  function acknowledgeWarn() {
    if (warnEl) warnEl.hidden = true;
    if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
    humanity = Math.min(100, humanity + 5);
    paintHUD();
  }

  // --- Post observer ---
  function setupPostObserver() {
    if (io) io.disconnect();
    io = new IntersectionObserver(onPostVisible, {
      rootMargin: "0px",
      threshold: 0.1,
    });
    observePosts();
  }

  function observePosts() {
    if (!io) return;
    document.querySelectorAll(POST_SELECTORS).forEach(function (el) {
      if (!postTimers.has(el)) io.observe(el);
    });
  }

  // --- MutationObserver ---
  function setupMutationObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(function () {
      attachScrollListeners();
      observePosts();
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // --- Scroll attachment ---
  var attachedScrolls = new WeakSet();
  function attachScrollListeners() {
    document.querySelectorAll(SCROLL_SELECTORS).forEach(function (el) {
      if (!attachedScrolls.has(el)) {
        el.addEventListener("scroll", onScroll, { passive: true });
        attachedScrolls.add(el);
      }
    });
  }

  // --- Lifecycle ---
  function start(opts) {
    opts = opts || {};
    enabled = opts.enabled !== false;
    persist = Boolean(opts.persist);
    reducedMotion = root.matchMedia
      ? root.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false;

    load();
    buildHUD();
    attachScrollListeners();
    setupPostObserver();
    setupMutationObserver();
    sessionStart = Date.now();
    lastScrollTs = sessionStart;
    lastScrollY = 0;

    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(tick, TICK_MS);

    paintHUD();
  }

  function stop() {
    enabled = false;
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (observer) { observer.disconnect(); observer = null; }
    if (io) { io.disconnect(); io = null; }
    if (hudEl) hudEl.hidden = true;
    if (warnEl) warnEl.hidden = true;
    if (glitchEl) glitchEl.hidden = true;
    document.body.classList.remove("cp-l0", "cp-l1", "cp-l2", "cp-l3", "cp-l4");
  }

  function reset() {
    humanity = 100;
    level = 0;
    sessionStart = Date.now();
    scrollSamples = [];
    activeBurstStart = 0;
    skimmedCount = 0;
    save();
    onLevelChange(false);
    paintHUD();
  }

  root.NBCyberpsych = {
    start: start,
    stop: stop,
    reset: reset,
    getHumanity: function () { return humanity; },
    getLevel: function () { return level; },
    LEVELS: LEVELS,
    _tick: tick,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
