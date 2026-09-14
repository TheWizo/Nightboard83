# Nightboard '83

**ATTENTION: This project is created by making heavy use of LLM systems (mostly 
[Mistral](https://mistral.ai)), if you don't want to use software created in 
this way this particular app may not be for you**

Nightboard '83 is a static web client for 
[Mastodon](https://docs.joinmastodon.org/client/intro/)-compatible servers, 
written with [GoToSocial](https://gotosocial.org/) in mind. It is a set of HTML, 
CSS, and JavaScript files with no build step and no backend of its own. The 
interface ships with German and English UI strings (default German), in an 
retrofuturistic neon style, and can be installed as a Progressive Web App.

Offline is the core idea: After an initial sync you can view your timelines, 
compose replies, react and create posts to push them back to the net the next 
time you have internet access. 

The client talks to the instance you configure (or type in at login) using OAuth 
2.0 with PKCE. 
After you authorize, the instance redirects back to Nightboard. A paste-the-code 
fallback remains for stubborn servers.

**Homepage:** [https://nightboard83.de](https://nightboard83.de) · 
**Demo-Installation:** 
[https://nightboard83.de/app/](https://nightboard83.de/app/) · **Quellcode:** 
[git.blackneon.net/ralf/Nightboard83](https://git.blackneon.net/ralf/
Nightboard83)


## Features

- Four independently scrollable columns: **Home**, **Local**, **Federated** (public timeline), and **Notifications**
- Offline cache (last timelines and media) via PouchDB / IndexedDB
- Outbox: compose or reply while offline, send automatically when the connection returns
- Drafts stored locally; a drafts icon appears in the header when any exist
- Installable as PWA
- Threads with replies, boosts, favourites, and a reply composer
- Local in-browser post translation via **Bergamot** WASM engine (24 language 
pairs, privacy-friendly)
- Two color themes: **default** (synthwave/CRT) and **cyberpunk-dark** (blue-black, red-orange, beveled), selectable via `config.json`
- **Cyberpsychosis Danger** doomscrolling detector: Tracks scroll velocity, 
session duration, post-consumption rate, and time of day to estimate a 
"humanity" score. Escalating CRT-glitch warnings fire when humanity drops. 
Configurable via `config.json` (`cyberpsych`)

## Requirements

- A web server that can serve static files (any origin is fine)
- A Mastodon-compatible instance with OAuth and the client API (GoToSocial is the primary target)
- A current browser (Chromium, Firefox, Safari). `file://` will not work: the app loads `config.json`, registers a service worker, and uses IndexedDB

For PWA install and a reliable service worker, serve the files over **HTTPS** (or `http://localhost`).

## Installation

Copy the project directory onto the server as-is. There is nothing to compile.

### Quick local preview

From the project root:

```bash
python3 -m http.server 8000
```

Open `http://127.0.0.1:8000/`.

### Production

Point any static host (nginx, Caddy, Apache, Git forge pages, object storage with a website mode) at this directory. Example nginx snippet:

```caddy
nightboard83.de {
        root * /var/www/Nightboard83.de
        file_server
}

```

The app checks for a new service worker on startup, when the tab becomes visible, and about every ten minutes. HTML, CSS, and JavaScript are fetched network-first (cache only if offline). If a new version is found, a SYS.UPDATE overlay runs a short install sequence, then the PWA reloads. If a compose or reply draft is open, the overlay pauses and dismisses so you can finish writing; the update resumes once the buffer is empty.

## Configuration

Edit `config.json` in the program directory. The file is fetched at startup (`cache: no-store`) and is **not** baked into the service worker precache, so changing it does not require a rebuild.

```json
{
  "instance": "fediverse2.blackneon.net",
  "poll_minutes": 2,
  "lang_switch": true,
  "federated": true,
  "local": true,
  "theme": "default",
  "cyberpsych": true
}
```

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `instance` | string | _(empty)_ | Hostname or URL used to **prefill** the instance field on the login screen. `https://` is added if you omit the scheme. Trailing slashes are stripped. Aliases: `url`, `host`. |
| `poll_minutes` | number | `2` | How often to look for new posts while you are logged in and no detail window is open. Allowed range: **0.25–1440** minutes (15 seconds to 24 hours). Aliases: `pollMinutes`, `polling_minutes`, `poll`. |
| `lang_switch` | boolean | `true` | Show the **DE | EN** language switcher on the login card and in the top bar. Set to `false` to hide it; the UI still uses the detected/locale-stored language. Aliases: `langSwitch`, `language_switch`, `showLangSwitch`. |
| `federated` | boolean | `true` | Show the **Federated** (public timeline) column and its dock icon. Set to `false` to remove the column entirely — it is not loaded, polled, or streamed. Aliases: `federatedTimeline`, `federated_timeline`, `showFederated`. |
| `local` | boolean | `true` | Show the **Local** column and its dock icon. Set to `false` to remove the column entirely — it is not loaded, polled, or streamed. Aliases: `localTimeline`, `local_timeline`, `showLocal`. |
| `theme` | string | `default` | Color theme. `default` is the original synthwave/CRT palette. `cyberpunk-dark` switches to a blue-black background with red-orange accents, beveled corners, and warm-toned icons. Unknown values fall back to `default`. Alias: `skin`. |
| `cyberpsych` | boolean | `true` | Enable the **Cyberpsychosis Danger** doomscrolling detector. When `true`, a humanity HUD appears below the top bar after login; it decays with fast/continuous scrolling and recovers during pauses, escalating through five levels (STABLE → ELEVATED → UNSTABLE → CRITICAL → CYBERPSYCHOSIS) with CRT-glitch effects and warning dialogs. Set to `false` to disable entirely. |

The login form can still point at a different instance. The last successful instance is stored in `localStorage` (`nightboard83.instance`) and wins over `config.json` on later visits. Changing the instance on login registers a new OAuth app on that server.

Polling is paused while a thread, profile, compose, media, drafts, or outbox dialog is open, and while the tab is hidden.

## First login

1. Open the app and, if needed, set the instance hostname.
2. Click **Autorisieren**. The instance’s OAuth consent page opens in the same window.
3. Approve access. You are redirected back to Nightboard and signed in.

Scopes requested: `read write follow`. If redirect login fails, use **Fallback: Code einfügen**.

Tokens and the registered app credentials stay in `localStorage` on that browser. Logout only drops the token and profile cache, not drafts or the outbox.

## Progressive Web App

`manifest.webmanifest` and `sw.js` enable install-to-homescreen. Install from the browser's install prompt, or on iOS Safari: Share → Add to Home Screen.

## Local data

All of this lives in the browser, not on your instance:

- Session: `localStorage` keys prefixed `nightboard83.`
- Timeline cache, media blobs, outbox, drafts: IndexedDB databases `nightboard83-cache`, `nightboard83-media`, `nightboard83-outbox`, `nightboard83-drafts` (PouchDB)

Clearing site data logs you out and deletes drafts and queued posts.

## Local post translation (Bergamot)

Posts can be translated **entirely in the browser** with the [Bergamot](https://browser.mt/) WASM engine. Post text never leaves the device.

- Engine and models: `assets/bergamot/` (lazy-loaded; models cached in Cache API)
- 24 language pairs (en↔de, es, fr, it, pt, ru, cs, bg, uk, zh, ja); pivot via English when no direct pair exists
- A "Translate" control appears only when source ≠ UI language and a registry path exists
- Falls back gracefully if WebAssembly or Workers are unavailable


## License

- Application code: **GNU Affero GPL v3 or later**
- Fonts in `fonts/` (Press Start 2P, VT323, Caveat): **SIL Open Font License 1.1** — see `fonts/OFL.txt`
- PouchDB (`js/pouchdb.min.js`): **Apache License 2.0**
- Bergamot translator (`assets/bergamot/`): **Mozilla Public License 2.0**
