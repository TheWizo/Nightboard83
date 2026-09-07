# Nightboard '83

Nightboard '83 is a static web client for [Mastodon](https://docs.joinmastodon.org/client/intro/)-compatible servers, written with [GoToSocial](https://gotosocial.org/) in mind. It is a set of HTML, CSS, and JavaScript files with no build step and no backend of its own. The interface is German, in an 1980s CRT / neon style, and can be installed as a Progressive Web App.

The client talks to the instance you configure (or type in at login) using OAuth 2.0 out-of-band (`urn:ietf:wg:oauth:2.0:oob`). After you authorize in a new tab, you paste the code back into Nightboard.

## Features

- Three independently scrollable columns: **Home**, **Local**, and **Notifications**
- Collapse columns to header icons (Atari TOS-style zoom); restore by clicking the icon
- Threads with replies, boosts, favourites, and a reply composer
- Profiles: follow / unfollow, mute, block
- Compose posts with optional content warning, visibility, and image or video attachments
- Drafts stored locally; a drafts icon appears in the header when any exist
- Offline cache (last timelines and media) via PouchDB / IndexedDB
- Outbox: compose or reply while offline, send automatically when the connection returns
- Connection status next to the instance hostname (connected / carrier lost / not connected)
- Configurable polling for new posts
- PWA with chrome 3D **NB '83** icons

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

```nginx
server {
    listen 443 ssl;
    server_name nightboard.example;

    root /var/www/nightboard83;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # Keep config.json from being cached forever by the browser
    location = /config.json {
        add_header Cache-Control "no-store";
    }
}
```

The app checks for a new service worker on startup, when the tab becomes visible, and about every ten minutes. HTML, CSS, and JavaScript are fetched network-first (cache only if offline). If a new version is found, a SYS.UPDATE overlay runs a short install sequence, then the PWA reloads. A typed but unsent compose or reply waits until that draft is gone.

## Configuration

Edit `config.json` in the program directory. The file is fetched at startup (`cache: no-store`) and is **not** baked into the service worker precache, so changing it does not require a rebuild.

```json
{
  "instance": "fediverse2.blackneon.net",
  "poll_minutes": 2
}
```

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `instance` | string | _(empty)_ | Hostname or URL used to **prefill** the instance field on the login screen. `https://` is added if you omit the scheme. Trailing slashes are stripped. Aliases: `url`, `host`. |
| `poll_minutes` | number | `2` | How often to look for new posts while you are logged in and no detail window is open. Allowed range: **0.25–1440** minutes (15 seconds to 24 hours). Aliases: `pollMinutes`, `polling_minutes`, `poll`. |

The login form can still point at a different instance. The last successful instance is stored in `localStorage` (`nightboard83.instance`) and wins over `config.json` on later visits. Changing the instance on login registers a new OAuth app on that server.

Polling is paused while a thread, profile, compose, media, drafts, or outbox dialog is open, and while the tab is hidden.

## First login

1. Open the app and, if needed, set the instance hostname.
2. Click **1. Autorisieren**. A new tab opens the instance’s OAuth consent page.
3. Approve access. The instance shows an authorization code (out-of-band).
4. Paste the code into **Authorization Code** and click **2. Token holen**.

Scopes requested: `read write follow push`.

Tokens and the registered app credentials stay in `localStorage` on that browser. Logout only drops the token and profile cache, not drafts or the outbox.

## Progressive Web App

`manifest.webmanifest` and `sw.js` enable install-to-homescreen. Icons are a chrome 3D **NB '83** wordmark over a synthwave grid. The maskable 512×512 asset keeps extra padding so Android adaptive shapes do not crop the lettering. Favicon is 32×32; iOS uses the 180×180 apple-touch icon.

Install from the browser’s install prompt (Chrome: the install icon in the address bar, or the menu). On iOS Safari: Share → Add to Home Screen.

## Local data

All of this lives in the browser, not on your instance:

- Session: `localStorage` keys prefixed `nightboard83.`
- Timeline cache, media blobs, outbox, drafts: IndexedDB databases `nightboard83-cache`, `nightboard83-media`, `nightboard83-outbox`, `nightboard83-drafts` (PouchDB)

Clearing site data logs you out and deletes drafts and queued posts.

## License

- Application code: **MIT**, Copyright 2026 Ralf Wissing — see `LICENSE`
- Fonts in `fonts/` (Press Start 2P, VT323, Caveat): **SIL Open Font License 1.1** — see `fonts/OFL.txt`
- PouchDB (`js/pouchdb.min.js`): **Apache License 2.0**
