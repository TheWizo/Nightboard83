# Nightboard '83 – Redesign-Projekt „Prisma"

Ziel: ein drittes Farb-Theme für den bestehenden Client, das die CRT/Synthwave-Ästhetik durch ein positiv futuristisches, freundlich-neon Design ersetzt. Alle technischen Features – insbesondere die Offline-Fähigkeit – bleiben vollständig erhalten.

## 1. Projektkontext

- Repo: https://git.blackneon.net/ralf/Nightboard83
- Stack: statischer Webclient, reines HTML/CSS/JS, kein Build-Schritt, kein Framework, kein Backend
- Lizenz: AGPL-3.0-or-later (neue Dateien unter dieselbe Lizenz stellen, SPDX-Header wie in bestehenden Dateien)
- Zielplattform: GoToSocial / Mastodon-kompatible Instanzen, PWA
- Relevante Dateien:
  - `index.html` – Body trägt Klasse `crt`, lädt `css/app.css` und `css/cyberpsych.css`, `<meta name="theme-color" content="#241b2f">`
  - `css/app.css` – ca. 32 KB, 16 CSS-Variablen in `:root`, CRT-Effekt-Layer unter `body.crt::before/::after` und `#app::before`
  - `css/cyberpsych.css` – HUD des Doomscrolling-Detektors
  - `config.json` – Laufzeitkonfiguration, u. a. `"theme": "default"` (alternative: `"cyberpunk-dark"`)
  - `sw.js` – Service Worker, aktuell Version 43, führt Precache und Update-Overlay (SYS.UPDATE)
  - `manifest.webmanifest`, `icons/` – PWA-Assets

## 2. Harte Regeln (nicht verletzen)

Diese Subsysteme dürfen funktional nicht angefasst werden. Reine Farbanpassungen an deren UI sind erlaubt, Logikänderungen nicht:

- OAuth 2.0 mit PKCE, Tokenverwaltung in `localStorage` (Präfix `nightboard83.`)
- Offline-Stack: PouchDB/IndexedDB-Datenbanken `nightboard83-cache`, `nightboard83-media`, `nightboard83-outbox`, `nightboard83-drafts`; Outbox-Queue, Drafts, Catch-up-Sync beim Boot
- Service-Worker-Mechanik: network-first-Strategie, Versionsprüfung beim Start/Visibility-Wechsel/alle 10 Minuten, Update-Overlay mit Draft-Schutz (pausiert bei offenem Compose/Reply)
- Bergamot-WASM-Übersetzung unter `assets/bergamot/` (lazy-load, Cache-API, 24 Sprachpaare, CORS-kritische Modell-URLs von Hugging Face – nicht anfassen)
- Polling-Logik, Spalten-Docking, i18n (DE/EN), Cyberpsychosis-Detektor-Logik (Scroll-Velocity, Session-Dauer, Humanity-Score, 5 Eskalationsstufen)
- Vier-Spalten-Layout: Home, Local, Federated, Notifications – unabhängig scrollbar, per config ein-/ausblendbar

Außerdem gilt: Prisma wird als drittes Theme neben `default` und `cyberpunk-dark` implementiert, nicht als Ersatz. `default` und `cyberpunk-dark` müssen unverändert weiterlaufen.

## 3. Design-Spezifikation „Prisma"

Stimmung: positiv futuristisch, freundlich-neon in Blau- und Cyan-Tönen mit Lime-Akzent, Solarpunk. Kein CRT, keine Scanlines, kein Flicker, keine chromatische Aberration. Stattdessen: weiche Glows, Aurora-Verläufe, transluzente Panels mit backdrop-blur, große Radien, moderne Sans-Schrift.

### 3.1 Palette

Als CSS-Variablen (an `:root` des Themes; Präfix analog zu bestehender Struktur):

```
--bg:        #131a3a   /* Basis-Hintergrund, helles Indigo */
--panel:     rgba(38, 47, 94, 0.6)
--panel-soft:rgba(46, 56, 108, 0.45)
--line:      rgba(155, 175, 255, 0.24)   /* Borders, Divider */
--fg:        #f2f5ff   /* Haupttext */
--muted:     #b0bae6   /* Sekundärtext */
--blue:      #5fd2ff   /* Primär-Akzent – hellblau */
--cyan:      #3ff0ff   /* Sekundär-Akzent */
--lime:      #a4ff5f   /* Erfolg / connected */
--deep:      #2b5cff   /* Tertiär-Akzent – dunkelblau */
--yellow:    #ffc857   /* Warnung */
--red:       #fe4450   /* Fehler / danger (beibehalten) */
--radius:    16px      /* Panels; Buttons 10px, Pills 999px */
```

Mapping auf bestehende Variablen: `--bg0→#131a3a`, `--bg1→--panel`, `--bg2→--panel-soft`, `--bg3→rgba(52,63,120,0.5)`, `--fg`, `--muted`, `--line` wie oben, `--comment→#b0bae6`.

### 3.2 Farbverläufe (Akkente, Buttons, Avatare, Statusanzeigen)

```
blue:   linear-gradient(135deg, #5fd2ff, #2b5cff)
cyan:   linear-gradient(135deg, #3ff0ff, #5f8bff)
lime:   linear-gradient(135deg, #a4ff5f, #3ff0ff)
amber:  linear-gradient(135deg, #ffc857, #5fd2ff)
deep:   linear-gradient(135deg, #2b5cff, #3ff0ff)
```

Primär-CTA (z. B. Autorisieren, Senden): `linear-gradient(90deg, #5fd2ff, #2b5cff, #3ff0ff)` mit `background-size: 200% 100%` und einer langsamen Shimmer-Animation (~4s linear infinite). Dunkle Schrift (`#0b0e1f`) auf allen Verläufen.

### 3.3 Glows (funktional, nicht dekorativ)

- Aktive Zustände: `box-shadow: 0 0 14px <Akzent>80`; aktive Interaktions-Buttons (Boost/Fav/Reply) `0 0 18px <Akzent>55`
- Verbindungsstatus online: Puls-LED `--lime` mit `box-shadow: 0 0 12px #a4ff5f`, Animation `pulse 2.4s infinite`
- Hover: leichte Aufhellung (`brightness(1.1)`) plus Akzent-Glow, keine Bewegung außer `translateY(-2px)` auf Karten
- Text-Glow nur für Logo und aktive Statusanzeigen: `text-shadow: 0 0 14px <Akzent>55`. Keine RGB-Splits.
- Karten-Hover: blauer Neon-Ring plus Glow: `box-shadow: 0 0 0 1px rgba(95,210,255,.45), 0 0 30px rgba(95,210,255,.25)` (Übergang 300ms)
- Panel-Grundglow: Topbar und Seitenspalten-Panels erhalten permanenten hellblauen Saum: `box-shadow: 0 0 26px rgba(95,210,255,.14)`
- Input-Fokus: Cyan-Border plus Glow: `border-color: rgba(63,240,255,.75); box-shadow: 0 0 18px rgba(63,240,255,.45)`
- Obere Neon-Kante: fixe 3px-Linie am oberen App-Rand mit fließendem Verlauf Hellblau→Cyan→Dunkelblau→Cyan→Hellblau, `background-size: 200% 100%`, `edgeflow`-Animation (~8s linear infinite), Glow `0 0 16px #5fd2ff99, 0 0 44px #3ff0ff55`
- Logo-Marke atmet: `breathe`-Animation (~3.6s ease-in-out infinite), Glow pendelt zwischen `0 0 16px #5fd2ff55` und `0 0 38px #5fd2ff99`
- Avatare: Glow-Ring `0 0 26px <Akzent>~5f` plus Innenlicht `0 0 6px rgba(255,255,255,.5)`
- Compose-Box als Glow-Zentrum: `box-shadow: 0 0 44px rgba(43,92,255,.32), 0 0 12px rgba(95,210,255,.28)` plus zwei interne Farb-Blobs (Hellblau oben rechts, Cyan unten links)
- Trend-Indikatoren: 1px-Verlaufsbalken mit `box-shadow: 0 0 16px <Akzent>cc`
- Tab-Pills: Hover-Glow `0 0 16px rgba(95,210,255,.55)`; aktive Pill `0 0 22px #5fd2ff88`
- Umfragen-Balken: Füllung mit `box-shadow: 0 0 14px <Akzent>66`, Opazität 0.3

### 3.4 Hintergrund: Aurora

Body-Basisfläche `#131a3a`, darauf sechs große, weiche, langsam driftende Farbflächen (radiale Gradients mit Alpha ~0.2–0.3, überwiegend Hellblau/Dunkelblau/Cyan plus ein Lime-Blob, je 300–460px). Drift-Animation: `transform: translate(0,0) scale(1)` → `translate(40px,-30px) scale(1.15)`, 14–23s ease-in-out infinite, je Fläche unterschiedliche Dauer/Richtung. Panels liegen mit `backdrop-filter: blur(14px)` darüber.

### 3.5 CRT-Layer ersetzen

Im Prisma-Theme müssen alle CRT-Regeln neutralisiert werden:

- `body.crt::after` (Scanlines, RGB-Phosphor, Vignette, crt-flicker) → deaktiviert
- `body.crt::before` (rollender Scan-Beam) → deaktiviert
- `#app::before` (Glasreflexion) → deaktiviert
- Bezel-Box-Shadows am Container → ersetzt durch dezente Panel-Schatten `0 8px 32px rgba(0,0,0,.26)`

Empfohlene Umsetzung: Prisma-Theme setzt eine Body-Klasse `theme-prisma`, und die CRT-Regelblöcke werden so erweitert, dass `body.crt.theme-prisma::before/::after` `content: none` erhalten – oder `index.html`/JS lassen die Klasse `crt` im Prisma-Theme gar nicht setzen. Letzteres ist sauberer, sofern der Theme-Switch vor dem ersten Paint greift (FOUC beachten).

### 3.6 Typografie

Neue Fonts als lokale woff2 unter `fonts/` (OFL-kompatibel, OFL.txt ergänzen):

- UI/Sans: „Outfit" (oder „Inter") – 400/600/800, Body 14–15px, Zeilenhöhe 1.55
- Display/Logo: „Outfit" 800, letter-spacing -0.02em, optional Glow

Die bestehende Type-Scale ist auf VT323 (26px) und Press Start 2P (8–10px) geeicht. Für Prisma gilt: Body-Text ~14.5px, UI-Labels/Buttons ~11–12px 600, Spalten-/Dialog-Titel ~13px 800. Das Vier-Spalten-Tiling, die Dialoge und die Topbar/Statusbar müssen mit den neuen Maßen neu austariert werden (Padding und Zeilenhöhen der Karten reduzieren, da Sans kompakter ist als VT323 bei gleicher Lesbarkeit).

### 3.7 Komponenten-Anpassungen

- Karten/Panels: `background: var(--panel)`, `border: 1px solid var(--line)`, `border-radius: 16px`, obere Akzent-Linie (1px, linear-gradient transparent→Akzent→transparent) optional pro Spaltentyp
- Buttons: Pill-Form (`border-radius: 999px`) für Primäraktionen, 10px für Tools; Ghost-Buttons transparent mit `--line`-Border
- Inputs: `background: rgba(255,255,255,.05)`, Fokus-Border `--cyan` plus Glow
- Timeline-Karten: Avatares als quadratische Verlaufs-Kacheln mit Glow-Ring (Verlauf nach Spalte/Typ)
- Boost/Fav/Reply-Buttons: inaktiv `--muted`, aktiv jeweiliger Akzent mit sanftem Glow und leichtem Scale (1.15, 200ms)
- Icons: bestehende SVGs nutzen `currentColor` – reine Recolors über CSS, keine Neuzeichnung nötig. Pixel-Icons mit `shape-rendering: crispEdges` können im Prisma-Theme auf `geometricPrecision` wechseln, Formen bleiben.
- CW-Button, Warn-Chips: `--yellow`-Verlauf mit Glow statt Amber-auf-Schwarz
- Scrollbars: `scrollbar-width: thin; scrollbar-color: rgba(140,160,255,.3) transparent`

### 3.8 Cyberpsychosis-HUD im Prisma-Theme

Logik unverändert. Nur die Darstellung übersetzen: CRT-Glitch-Eskalation wird zu Glow-Eskalation. Vorschlag: Humanity-Score als kleiner Kreis-Indikator unter der Topbar, Farbe läuft lime → cyan → yellow → orange → red, Glow-Radius und Pulsfrequenz steigen pro Stufe. Warn-Dialoge im Prisma-Panel-Stil. Die Stufennamen (STABLE → CYBERPSYCHOSIS) bleiben.

### 3.9 Animationen & Accessibility

Alle neuen Animationen (Shimmer, Drift, Puls, Glow) unter `@media (prefers-reduced-motion: reduce)` deaktivieren oder auf Farbübergänge reduzieren – analog zur bestehenden reduced-motion-Regel.

## 4. Implementierungsschritte

1. Analyse: Ermittle, wie `theme: "cyberpunk-dark"` aktuell geladen wird (JS-gesteuertes Stylesheet, Body-Klasse oder eingebetteter Block) und reproduziere exakt diesen Mechanismus für `"prisma"`.
2. Neue Theme-Ressource anlegen (z. B. `css/prisma.css`) mit Palette, Aurora-Hintergrund, CRT-Neutralisierung, Typografie und Komponenten-Overrides. Alle Regeln mit dem Theme-Selektor präfixen, damit default/cyberpunk-dark unberührt bleiben.
3. Fonts beschaffen und einbetten (Outfit/Inter, woff2, `@font-face` mit `font-display: swap`, `fonts/OFL.txt` ergänzen).
4. config.json-Plumbing: `"theme": "prisma"` akzeptieren; unbekannte Werte fallen wie bisher auf `default` zurück. Doku im README (Theme-Tabelle) ergänzen.
5. JS-Inline-Farben anfassen, die nicht über CSS laufen: SYS.UPDATE-Overlay, Glitch-Warnungen, ggf. Canvas-Zeichnungen im Cyberpsych-HUD. Theme-abhängig verzweigen (Design-Tokens als JS-Objekt `THEME_COLORS` auslagern, damit künftige Themes profitieren).
6. `<meta name="theme-color">` für das Prisma-Theme auf `#131a3a` setzen (JS-seitig beim Theme-Wechsel, wie bei cyberpunk-dark gehandhabt).
7. Service Worker: Version bumpen (v43 → v44), neue Dateien (`css/prisma.css`, Fonts) in den Precache aufnehmen. Update-Flow einmal komplett durchtesten (Overlay, Draft-Pause, Reload).
8. Barrierefreiheit: reduced-motion für alle neuen Animationen; Kontraste der Neon-Akzente auf `--bg` prüfen (Ziel WCAG AA für Fließtext; Akzentfarben nur für UI-Chrome/Großtext einsetzen).
9. Regressionstests, siehe Abschnitt 6.

## 5. Abgrenzung / Out of Scope

- Keine Änderungen an PouchDB-Schemas, Outbox-Logik, SW-Caching-Strategien
- Keine Änderungen an OAuth-Flow, i18n-Strings, Polling
- Keine Bergamot-Assets oder Modell-URLs anfassen
- Keine neuen PWA-Icons (optionaler Folgeschritt: Prisma-Icon-Set)
- Kein Entfernen der Themes `default` und `cyberpunk-dark`

## 6. Abnahmekriterien

- `config.json` mit `"theme": "prisma"` liefert das neue Design; `"default"` und `"cyberpunk-dark"` rendern unverändert
- Keine Scanlines, kein Flicker, kein Bezel im Prisma-Theme; Aurora-Hintergrund sichtbar, Panels mit backdrop-blur
- Offline-Flow funktioniert wie zuvor: Flugmodus, App öffnen, Timelines aus Cache, Reply komponieren, Draft/Outbox-Icon sichtbar, online gehen → Outbox leert sich automatisch
- Bergamot-Übersetzung eines Posts im Prisma-Theme ohne optische Brüche
- Cyberpsych-HUD zeigt alle 5 Stufen mit Glow-Eskalation, Logik unverändert
- PWA-Update: neue SW-Version wird erkannt, SYS.UPDATE-Overlay pausiert bei offenem Draft, Reload lädt Prisma korrekt
- Vier Spalten unabhängig scrollbar, Dock-Icons (collapse/restore) funktional, `federated: false` / `local: false` aus config respektiert
- `prefers-reduced-motion: reduce` stoppt Shimmer/Drift/Puls
- Deutsch und Englisch ohne abgeschnittene Labels in Buttons/Chips (Sans ist schmaler als Press Start 2P – explizit prüfen)

## 7. Referenz-Prototyp

Ein interaktiver Mockup-Prototyp „Prisma" (dreispaltiges Layout mit Compose-Box, Timeline-Karten, Polls, CW, Trends, Verbindungsstatus) existiert als Design-Referenz im zugehörigen Vibe-Chat. Die dort verwendeten exakten Farb-, Verlaufs- und Glow-Werte sind in Abschnitt 3 vollständig übernommen. Der Prototyp ist React; er dient nur als visuelle Referenz – die Implementierung im Nightboard erfolgt als reines CSS nach dieser Spezifikation.