# Cyberpsychosis Danger — Doomscrolling Detector

Drop-in Modul für Nightboard '83. Verfolgt Scroll-Verhalten, errechnet einen "Humanity"-Score (Cyberpunk-2077-Logik) und eskaliert visuell, wenn der Nutzer doomscrollt. Alles in einer Datei, kein Build, kein Dependency.

## Architektur

```
  Scroll-Events ──┐
                  ├──→ Velocity/Distance Tracker
  Session-Clock ──┤
                  ├──→ Humanity Engine (decay/recover)
  Time-of-Day ────┤
                  ├──→ Threat Assessor (level 0-4)
  Posts via IO ───┘        │
                           ▼
                    HUD Overlay + Glitch FX
```

Fünf Signale fliessen in den Humanity-Score:

1. Scroll-Geschwindigkeit (px/min über gleitendes 60s-Fenster)
2. Kontinuierliches Scrollen ohne Pause >3s
3. Posts, die schnell durchs Viewport rauschen (IntersectionObserver, <1.5s sichtbar)
4. Session-Dauer seit letzter Pause >5min
5. Uhrzeit 22:00-05:00 lokaler Zeit (1.5x Multiplikator)

Humanity startet bei 100, zerfällt bei Doomscrolling, erholt sich bei Pausen >10s.

Level: STABLE (100-80) → ELEVATED (80-60) → UNSTABLE (60-40) → CRITICAL (40-20) → CYBERPSYCHOSIS (20-0).

## Datei 1: js/cyberpsych.js

```javascript
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
  const TICK_MS = 2000;           // humanity engine tick
  const SCROLL_WINDOW_MS = 60000; // velocity rolling window
  const PAUSE_THRESHOLD_MS = 3000; // gap that ends an "active" burst
  const RECOVERY_PAUSE_MS = 10000; // pause long enough to start recovery
  const RECOVERY_FULL_MS = 120000; // pause that fully restores humanity
  const FAST_POST_MS = 1500;      // post visible < this = "skimmed"
  const NIGHT_START = 22;         // hour
  const NIGHT_END = 5;

  // Decay rates (humanity points per tick) by signal contribution.
  const DECAY = {
    velocity: 0.45,
    continuous: 0.30,
    skimRate: 0.35,
    session: 0.15,
  };
  const RECOVER_PER_TICK = 3.2;
  const NIGHT_MULT = 1.5;

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

      if (vel > 2000) decay += DECAY.velocity * Math.min(3, vel / 4000);
      if (burst > 30000) decay += DECAY.continuous * Math.min(2, burst / 60000);
      if (skimmedCount > 5) decay += DECAY.skimRate * Math.min(3, skimmedCount / 10);
      skimmedCount = 0;
      if (sess > 300000) decay += DECAY.session * Math.min(2, sess / 600000);
      if (isNight()) decay *= NIGHT_MULT;

      humanity = Math.max(0, humanity - decay);
    }

    save();
    const newLevel = levelFor(humanity);
    if (newLevel !== level) {
      level = newLevel;
      onLevelChange();
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
    document.body.appendChild(hudEl);

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
    hudEl.hidden = level === 0 && humanity >= 100;
    barEl.style.width = pct + "%";
    barEl.style.background = lv.color;
    barEl.style.boxShadow = "0 0 12px " + lv.color;
    labelEl.textContent = t("cyberpsych.level." + lv.name);
    pctEl.textContent = pct + "%";
    hudEl.className = "cp-hud " + lv.cls;
  }

  function onLevelChange() {
    const lv = LEVELS[level];

    if (glitchEl) {
      glitchEl.hidden = level < 2;
      glitchEl.className = "cp-glitch cp-glitch-l" + level;
    }

    document.body.classList.remove("cp-l0", "cp-l1", "cp-l2", "cp-l3", "cp-l4");
    document.body.classList.add("cp-l" + level);

    if (level >= 2 && warnEl) {
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
    onLevelChange();
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
```

## Datei 2: CSS (cyberpsych.css oder in styles.css aufnehmen)

```css
/* === Cyberpsychosis Danger HUD === */

.cp-hud {
  position: fixed;
  top: 8px;
  right: 12px;
  z-index: 9990;
  pointer-events: none;
  opacity: 0;
  transition: opacity 0.4s ease;
}
.cp-hud:not([hidden]) { opacity: 1; }

.cp-hud-inner {
  display: flex;
  align-items: center;
  gap: 8px;
  background: #241b2fcc;
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 4px 10px;
  backdrop-filter: blur(4px);
  font-family: "Press Start 2P", monospace;
  font-size: 7px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.cp-hud-label { color: var(--muted); white-space: nowrap; }

.cp-hud-bar-track {
  width: 80px;
  height: 8px;
  background: var(--bg0);
  border: 1px solid var(--line);
  border-radius: 2px;
  overflow: hidden;
}
.cp-hud-bar-fill {
  height: 100%;
  width: 100%;
  background: var(--mint);
  transition: width 1s ease, background 0.6s ease;
}

.cp-hud-pct {
  color: var(--fg);
  font-size: 7px;
  min-width: 30px;
  text-align: right;
}

.cp-hud.cp-elevated .cp-hud-label { color: var(--yellow); text-shadow: 0 0 6px #fede5d66; }
.cp-hud.cp-unstable .cp-hud-label { color: var(--orange); text-shadow: 0 0 8px #f97e7288; animation: cp-blink 1.5s infinite; }
.cp-hud.cp-critical .cp-hud-label { color: var(--red); text-shadow: 0 0 10px #fe4450aa; animation: cp-blink 0.8s infinite; }
.cp-hud.cp-cyberpsych .cp-hud-label { color: var(--red); animation: cp-blink 0.4s infinite; }

@keyframes cp-blink {
  0%, 49% { opacity: 1; }
  50%, 100% { opacity: 0.3; }
}

/* === Glitch overlay === */
.cp-glitch {
  position: fixed;
  inset: 0;
  z-index: 9985;
  pointer-events: none;
  mix-blend-mode: screen;
}

.cp-glitch.cp-glitch-l2 {
  background: repeating-linear-gradient(0deg, transparent 0px, rgba(249,126,114,0.04) 1px, transparent 2px, transparent 4px);
  animation: cp-glitch-mild 3s infinite;
}
.cp-glitch.cp-glitch-l3 {
  background:
    repeating-linear-gradient(0deg, transparent 0px, rgba(254,68,80,0.06) 1px, transparent 2px, transparent 3px),
    repeating-linear-gradient(90deg, transparent 0px, rgba(254,68,80,0.03) 1px, transparent 2px);
  animation: cp-glitch-hard 1.5s infinite;
}
.cp-glitch.cp-glitch-l4 {
  background:
    repeating-linear-gradient(0deg, transparent 0px, rgba(254,68,80,0.10) 1px, transparent 2px),
    repeating-linear-gradient(90deg, rgba(255,126,219,0.04) 0px, transparent 1px, rgba(3,237,249,0.04) 2px, transparent 3px);
  animation: cp-glitch-critical 0.5s infinite;
}

@keyframes cp-glitch-mild {
  0%, 100% { transform: translateX(0); opacity: 0.6; }
  50% { transform: translateX(1px); opacity: 0.8; }
}
@keyframes cp-glitch-hard {
  0%, 100% { transform: translate(0,0); opacity: 0.7; }
  20% { transform: translate(-2px, 1px); opacity: 0.9; }
  60% { transform: translate(2px, -1px); opacity: 0.8; }
}
@keyframes cp-glitch-critical {
  0%, 100% { transform: translate(0,0); opacity: 0.8; }
  10% { transform: translate(-3px, 2px); }
  20% { transform: translate(3px, -1px); }
  30% { transform: translate(-1px, 1px); }
  70% { transform: translate(2px, 2px); opacity: 1; }
}

/* Body-level CRT distortion */
body.cp-l2 { animation: cp-shake-subtle 4s infinite; }
body.cp-l3 { animation: cp-shake-moderate 2s infinite; }
body.cp-l4 { animation: cp-shake-hard 0.8s infinite; filter: hue-rotate(-5deg) contrast(1.05); }

@keyframes cp-shake-subtle {
  0%, 100% { transform: translate(0,0); }
  50% { transform: translate(0.3px, 0); }
}
@keyframes cp-shake-moderate {
  0%, 100% { transform: translate(0,0); }
  25% { transform: translate(-0.6px, 0.3px); }
  75% { transform: translate(0.6px, -0.3px); }
}
@keyframes cp-shake-hard {
  0%, 100% { transform: translate(0,0); }
  20% { transform: translate(-1px, 0.5px); }
  40% { transform: translate(1px, -0.5px); }
  60% { transform: translate(-0.5px, 1px); }
  80% { transform: translate(0.5px, -1px); }
}

/* === Warning overlay === */
.cp-warn-overlay {
  position: fixed;
  inset: 0;
  z-index: 9995;
  display: flex;
  align-items: center;
  justify-content: center;
  background: radial-gradient(ellipse at center, #191621dd 0%, #050308ee 100%);
  backdrop-filter: blur(3px);
}
.cp-warn-overlay[hidden] { display: none; }

.cp-warn-box {
  text-align: center;
  max-width: 440px;
  padding: 36px 32px;
  background: #241b2fdd;
  border: 1px solid var(--red);
  border-radius: var(--radius);
  box-shadow: 0 0 60px #fe445033, inset 0 0 30px #fe445022;
}

.cp-warn-icon {
  font-size: 48px;
  color: var(--red);
  text-shadow: 0 0 20px #fe4450aa, 2px 0 0 #03edf955, -2px 0 0 #ff7edb55;
  animation: cp-blink 1s infinite;
  margin-bottom: 16px;
}

.cp-warn-title {
  font-family: "Press Start 2P", monospace;
  font-size: 13px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--red);
  text-shadow: 1px 0 0 #ff7edb55, -1px 0 0 #03edf955, 0 0 12px #fe4450aa;
  margin-bottom: 16px;
}

.cp-warn-msg {
  font-family: "VT323", monospace;
  font-size: 20px;
  color: var(--muted);
  line-height: 1.4;
  margin-bottom: 24px;
}

.cp-warn-actions { display: flex; gap: 12px; justify-content: center; }

.cp-warn-btn {
  font-family: "Press Start 2P", monospace;
  font-size: 8px;
  padding: 10px 16px;
  border: 1px solid var(--red);
  border-radius: 2px;
  background: linear-gradient(180deg, #3a2150, #2a1638);
  color: var(--fg);
  cursor: pointer;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  transition: border-color 0.2s;
}
.cp-warn-btn:hover { border-color: var(--cyan); }
.cp-warn-btn-ghost {
  background: transparent;
  border-color: var(--line);
  color: var(--muted);
}

@media (prefers-reduced-motion: reduce) {
  .cp-glitch, body.cp-l2, body.cp-l3, body.cp-l4 { animation: none !important; }
  .cp-hud.cp-unstable .cp-hud-label,
  .cp-hud.cp-critical .cp-hud-label,
  .cp-hud.cp-cyberpsych .cp-hud-label,
  .cp-warn-icon { animation: none !important; }
}
```

## Datei 3: i18n Keys

### i18n/de.json (zusätzlich)

```json
{
  "cyberpsych.level.stable": "STABIL",
  "cyberpsych.level.elevated": "ERHÖHT",
  "cyberpsych.level.unstable": "INSTABIL",
  "cyberpsych.level.critical": "KRITISCH",
  "cyberpsych.level.cyberpsych": "CYBERPSYCHOSE",
  "cyberpsych.warn.elevated.title": "Nervensystem-Belastung erkannt",
  "cyberpsych.warn.elevated.msg": "Dein Scroll-Verhalten zeigt Anzeichen von Doomscrolling. Kurz innehalten?",
  "cyberpsych.warn.unstable.title": "Mentale Stabilität sinkt",
  "cyberpsych.warn.unstable.msg": "Du scrollst seit einer Weile ohne Pause. Empfehlung: 2 Minuten Pause, dann weiter.",
  "cyberpsych.warn.critical.title": "CYBERPSYCHOSE-RISIKO",
  "cyberpsych.warn.critical.msg": "Humanity-Wert kritisch. Erwäge, das Gerät für einige Minuten abzulegen.",
  "cyberpsych.warn.cyberpsych.title": "CYBERPSYCHOSE",
  "cyberpsych.warn.cyberpsych.msg": "Humanity auf null. Kognitive Überlastung. Sofortige Disengagement-Empfehlung.",
  "cyberpsych.dismiss": "Weiter scrollen",
  "cyberpsych.acknowledge": "Verstanden — Pause"
}
```

### i18n/en.json (zusätzlich)

```json
{
  "cyberpsych.level.stable": "STABLE",
  "cyberpsych.level.elevated": "ELEVATED",
  "cyberpsych.level.unstable": "UNSTABLE",
  "cyberpsych.level.critical": "CRITICAL",
  "cyberpsych.level.cyberpsych": "CYBERPSYCHOSIS",
  "cyberpsych.warn.elevated.title": "Nervous system stress detected",
  "cyberpsych.warn.elevated.msg": "Your scroll pattern shows signs of doomscrolling. Consider a brief pause.",
  "cyberpsych.warn.unstable.title": "Mental stability declining",
  "cyberpsych.warn.unstable.msg": "You've been scrolling without pause for a while. Suggested: 2-minute break, then resume.",
  "cyberpsych.warn.critical.title": "CYBERPSYCHOSIS RISK",
  "cyberpsych.warn.critical.msg": "Humanity critical. Consider putting the device down for a few minutes.",
  "cyberpsych.warn.cyberpsych.title": "CYBERPSYCHOSIS",
  "cyberpsych.warn.cyberpsych.msg": "Humanity at zero. Cognitive overload. Immediate disengagement recommended.",
  "cyberpsych.dismiss": "Keep scrolling",
  "cyberpsych.acknowledge": "Acknowledged — pausing"
}
```

## Integration in Nightboard '83

### index.html

```html
<!-- Im <head> nach bestehendem CSS -->
<link rel="stylesheet" href="css/cyberpsych.css" />

<!-- Vor js/app.js, nach js/translate.js -->
<script src="js/cyberpsych.js"></script>
```

### js/app.js

Nach Login, wenn die Columns sichtbar sind:

```javascript
if (window.NBCyberpsych) {
  NBCyberpsych.start({ persist: false, enabled: true });
}
```

Bei Logout:

```javascript
if (window.NBCyberpsych) {
  NBCyberpsych.stop();
}
```

### sw.js

`js/cyberpsych.js` und `css/cyberpsych.css` in die Precache-Liste aufnehmen. Cache-Version bumpen (v39 -> v40).

### Selektoren anpassen

Falls die Scroll-Container oder Post-Selektoren abweichen, die Konstanten am Kopf von cyberpsych.js anpassen:

```javascript
const SCROLL_SELECTORS = ".col-body, .col-scroll, [data-col-body]";
const POST_SELECTORS = "article.status, article[data-status-id], .status-card";
```

## Tuning-Parameter

| Parameter | Default | Wirkung |
|---|---|---|
| DECAY.velocity | 0.45 | Geschwindigkeits-Einfluss |
| DECAY.continuous | 0.30 | "Keine Pause"-Einfluss |
| DECAY.skimRate | 0.35 | "Posts ueberfliegen"-Einfluss |
| DECAY.session | 0.15 | Session-Laenge |
| RECOVER_PER_TICK | 3.2 | Erholung pro 2s-Tick bei Pause |
| NIGHT_MULT | 1.5 | Multiplikator 22:00-05:00 |
| FAST_POST_MS | 1500 | Schwelle: Post <1.5s sichtbar = ueberflogen |
| PAUSE_THRESHOLD_MS | 3000 | Scroll-Pause >3s beendet aktiven Burst |

## Known Issues

- MutationObserver auf document.body feuert oft bei Timeline-Updates. Bei Performance-Problemen auf die Column-Container scopen.
- humanity ist pro-Browser, nicht pro-Instanz. Bei Multi-Account-Wechsel reset() aufrufen.
- Die scrollSamples werden pro global geteilt, nicht pro Spalte. Bei sehr breiten Multi-Column-Layouts evtl. pro Spalte tracken.