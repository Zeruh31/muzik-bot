# Müzik Bot

[Türkçe](README.md) · **English**

An open-source Discord music bot that you run on your own computer. It plays YouTube (and, optionally, Spotify links through their YouTube equivalents) and works with slash (`/`) commands only. It comes with an optional web panel and a Windows desktop app that runs everything without console windows.

> **Language:** the bot's messages, the web panel and the desktop app are **Turkish only**. The full, step-by-step guide is the [Turkish README](README.md); this page is a complete but shorter English summary.

| Home | Servers | Statistics |
|---|---|---|
| ![Desktop app home screen](docs/ekran-ana.png) | ![Servers tab](docs/ekran-sunucular.png) | ![Statistics tab](docs/ekran-istatistik.png) |
| **Settings (.env form)** | **YouTube sign-in wizard** | |
| ![Settings tab](docs/ekran-ayarlar.png) | ![YouTube sign-in](docs/ekran-youtube.png) | |

<sub>Servers, songs and numbers in the screenshots are made-up test data.</sub>

## How it works

- **discord.js 14** on Node.js 24; voice is sent by the bot itself with **@discordjs/voice** + **@snazzah/davey** (Discord's DAVE end-to-end encrypted voice), **@discordjs/opus** and **ffmpeg**.
- **Lavalink 4.2.2** is used only over REST, for search, resolving links, the YouTube audio stream and lyrics. In some network and Windows setups the voice packets sent by Lavalink's own voice library (koe) never reached Discord, while sending from the bot with @discordjs/voice worked reliably, so Lavalink is only the search and audio source. Plugins: youtube-plugin (pinned snapshot, see below), LavaSrc (Spotify), LavaLyrics.
- The **web panel** (Express) lets members of a server control the music from a browser after signing in with Discord.
- The **desktop app** (Electron, Windows) edits `.env` as a form, downloads Lavalink with a SHA-256 check, guides the YouTube sign-in, registers the commands, starts and stops the bot and Lavalink as hidden processes, and shows logs, servers and statistics.

## Requirements

| | |
|---|---|
| OS | Windows 10/11. The desktop app is Windows only. The bot and Lavalink are plain Node.js and Java and may run on Linux/macOS, but they were only tested on Windows, and the helper scripts need PowerShell 7. |
| Node.js | 24 or newer |
| Java | 17 or newer (21 recommended), for Lavalink |
| ffmpeg | On `PATH`, otherwise the optional `ffmpeg-static` package installed by `npm install` is used |
| Discord access | If Discord is blocked in your country or network, the bot cannot connect either; keep your access tool (VPN etc.) on while it runs |

## Setup

1. `npm install`
2. Create an application and a bot at <https://discord.com/developers/applications>. Copy the **Application ID** and the bot **token**. No privileged intents are needed. Invite the bot with `https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot+applications.commands&permissions=3165184`.
3. Choose one way to run it:
   - **Desktop app (Windows, recommended):** `npm --prefix desktop install` once, then `npm run masaustu`. Build an installer and a portable exe with `npm run masaustu:paket` (output in `desktop/dist/`). Everything below can then be done from inside the app.
   - **Command line:** copy `.env.example` to `.env` and fill it in (at least `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `LAVALINK_PASSWORD`), run `npm run lavalink:indir` once (downloads Lavalink from GitHub and verifies its SHA-256), sign in to YouTube (next section), `npm run deploy-commands`, then `npm run hepsi` (starts Lavalink and the bot) or `npm run lavalink` and `npm start` in two windows. `npm run kontrol` checks the whole setup.

> **Unsigned executables:** the desktop app's exe files are not code-signed, so Windows SmartScreen may warn on first launch ("More info" > "Run anyway"). Building them yourself from this repository is the safest option.

### YouTube sign-in

YouTube blocks anonymous bots, so Lavalink signs in with a Google account through the OAuth device flow: start Lavalink with an empty `YOUTUBE_OAUTH_REFRESH_TOKEN`, open <https://www.google.com/device>, enter the code it prints, then run `npm run youtube-token` to store the token in `.env` (the desktop app does all of this for you). **Do not use your main Google account**: such use can get an account closed, so use a throwaway secondary account.

### Spotify (optional)

Create an app at <https://developer.spotify.com/dashboard> (Web API, redirect URI `http://127.0.0.1:8888/callback`) and put its Client ID and secret into `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET`. Since February 2026 Spotify requires the app owner to have **Spotify Premium** for development-mode apps.

### Configuration

All settings live in `.env`; `.env.example` explains every key (in Turkish). Besides the Discord, Lavalink, YouTube and Spotify keys there are music behaviour settings (volume, 24/7 mode, idle timeouts, search source, queue size, embed colour), the web panel (`PANEL_*`, `DISCORD_CLIENT_SECRET`), `BOT_OWNER_IDS` for owner-only commands, and the optional `/help` links `BRAND_SUPPORT_URL`, `BRAND_AUTHOR_NAME`, `BRAND_AUTHOR_URL` (https only; empty values are not shown).

### Web panel (optional)

Set `PANEL_ENABLED=true`, `DISCORD_CLIENT_SECRET` (Developer Portal > OAuth2) and add the redirect `http://127.0.0.1:3000/auth/callback`. Open exactly `http://127.0.0.1:3000`. Only members who are in the bot's voice channel can control playback; the server-side checks also apply the `/dj` role. Do not expose it to the internet without an HTTPS reverse proxy.

## Commands

`/play`, `/search`, `/playfirst`, `/skip`, `/skipto`, `/pause`, `/resume`, `/stop`, `/disconnect`, `/queue`, `/nowplaying`, `/loop`, `/loopqueue`, `/shuffle`, `/remove`, `/move`, `/clear`, `/seek`, `/volume`, `/bassboost`, `/grab`, `/lyrics`, `/help`, `/invite`, `/stats`, `/dj` (DJ role), `/servers` (bot owner only). Descriptions are in the [Turkish README](README.md#11-komutlar).

## Known limitations

- **Sources:** only YouTube and Spotify links and song names can be played (Spotify needs Premium as noted above). SoundCloud, Bandcamp, Twitch etc. can be searched but not played yet.
- **No live streams.**
- **Seeking can be slow** on long tracks: the audio is buffered in memory first.
- **Memory:** each playing track is buffered per server, and Lavalink uses its own heap (`LAVALINK_JAVA_MEMORY`, 512 MB by default).
- **YouTube changes often.** The youtube-plugin is pinned to a **snapshot commit** because the latest stable release (1.18.2) could not play most videos at the time; the snapshot's iOS client works without signature deciphering. Switch back to a numbered release once one works again (details in the Turkish README, *Teknik notlar > YouTube eklentisi*).
- Tested on Windows only.

## Development

```powershell
npm test                    # bot tests
npm run check               # node --check for every file + command definition check
npm run format:check        # Prettier
npm --prefix desktop test   # desktop app tests
```

`test/contract.test.js` pins what the desktop app relies on (entry points, console lines, `.env` keys and the `data/durum.json` status file schema).

## Disclaimer

This is an unofficial project. It is not affiliated with, endorsed by or connected to YouTube, Google, Spotify or Discord. You are responsible for how you use it and for complying with those platforms' terms of service. The software is provided "as is", see [LICENSE](LICENSE).

## Third-party components

None of these are included in this repository; `npm install`, `npm run lavalink:indir` and Lavalink's first start download them from their own sources. Licenses were checked against the upstream repositories.

| Component | Used for | License |
|---|---|---|
| [Lavalink](https://github.com/lavalink-devs/Lavalink) | Search, sources, YouTube stream | MIT |
| [youtube-source / youtube-plugin](https://github.com/lavalink-devs/youtube-source) | YouTube source for Lavalink | MIT |
| [LavaSrc](https://github.com/topi314/LavaSrc) | Spotify mirroring, lyrics sources | Apache-2.0 |
| [LavaLyrics](https://github.com/topi314/LavaLyrics) | Lyrics | Apache-2.0 |
| [discord.js](https://github.com/discordjs/discord.js) | Discord client | Apache-2.0 |
| [@discordjs/voice](https://github.com/discordjs/discord.js/tree/main/packages/voice) | Voice connection | Apache-2.0 |
| [@discordjs/opus](https://github.com/discordjs/opus) | Opus encoding | MIT |
| [@snazzah/davey](https://github.com/Snazzah/davey) | DAVE end-to-end encryption | MIT |
| [Express](https://github.com/expressjs/express), express-session, express-rate-limit | Web panel | MIT |
| [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) (optional) | ffmpeg binary when none is on `PATH` | GPL-3.0-or-later (the FFmpeg builds it downloads are GPL too) |
| [Electron](https://github.com/electron/electron), [electron-builder](https://github.com/electron-userland/electron-builder) | Desktop app | MIT |

## License, contributing, security

- [MIT License](LICENSE)
- [Contributing](CONTRIBUTING.md)
- Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md), not in public issues.
