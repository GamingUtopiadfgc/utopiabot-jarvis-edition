# UtopiaBot — JARVIS Edition

A Jarvis-style desktop AI assistant: an animated arc-reactor HUD, voice in/out,
text chat, a real Claude AI brain, and a handful of local commands.

![HUD: arc reactor centre, status panels left, waveform + toggles right]

## Features

- **Arc-reactor HUD** — animated reactor core (canvas), rotating tech rings,
  particles, live clock, faux diagnostics, and a reactive waveform. The reactor
  changes colour by state: standby (cyan), listening (gold), thinking (violet),
  speaking (teal).
- **Two brains, switchable** — pick from the **NEURAL CORE** dropdown:
  - **Claude** — streams from `claude-opus-4-8` with adaptive thinking + a
    cached system prompt.
  - **Ollama (local)** — any model you've pulled locally (llama3, mistral,
    qwen, …). Runs offline, free, and private. **The app auto-starts the Ollama
    server in a terminal on launch** if it isn't already running, then refreshes
    the model list once it's up. Hit the rescan button (↻) after pulling new
    models. (Disable auto-start with `JARVIS_NO_OLLAMA_AUTOSTART=1`.)

  Both share the same JARVIS persona (dry wit, concise, spoken-friendly).
- **Voice** — speak to it (browser speech recognition) and it talks back
  (text-to-speech, prefers a British voice). Optional auto-listen for
  hands-free back-and-forth.
- **Settings window** (⚙ in the title bar) — 8 sections persisted to
  `settings.json`: General (start with Windows, tray, notifications, Ollama
  auto-launch), Voice (engine, wake word, auto-listen, speak, voice, mic),
  Neural Core (provider, model, temperature, context length, max tokens, system
  prompt), Memory Bank, Automation, Appearance (4 themes, font scale, animation
  toggles), live System stats (CPU/RAM/GPU), and Advanced (Ollama URL, dev
  console, debug logs). Themes recolor the whole HUD including the reactor.
- **Self-aware (reads its own code)** — both brains have `list_files` and
  `read_file` tools, sandboxed to the project folder, so you can ask "what's in
  your reactor.js?" or "how does your command parser work?" and JARVIS reads the
  real file before answering. `.env`, `.git`, and `node_modules` are blocked, so
  it can't leak your API key or wander outside the project.
- **Local commands** — time, date, open websites/apps, web search — handled
  instantly without calling the model.
- **Frameless custom window** — draggable Stark-style title bar.

## Setup

1. **Install dependencies**

   ```powershell
   npm install
   ```

2. **Pick at least one brain** (you can have both):

   - **Claude** — copy `.env.example` to `.env` and paste your key from
     <https://console.anthropic.com/settings/keys>:

     ```
     ANTHROPIC_API_KEY=sk-ant-...
     ```

   - **Ollama (local)** — install <https://ollama.com>, then pull a model:

     ```powershell
     ollama pull llama3.1
     ```

     UtopiaBot auto-detects the running Ollama server at
     `http://127.0.0.1:11434` (override with `OLLAMA_HOST`). Pulled models
     appear in the NEURAL CORE dropdown.

   The UI still runs with neither — voice, TTS, and local commands work; the AI
   brain stays offline until a provider is reachable.

3. **Run**

   ```powershell
   npm start
   ```

   For dev tools: `npm run dev`.

## Build a Windows installer (.exe)

Package UtopiaBot into an installable app with desktop + Start Menu shortcuts
and an uninstaller:

```powershell
npm install        # once, pulls in electron-builder
npm run dist
```

The installer is written to `dist\UtopiaBot JARVIS Setup <version>.exe`. Run it
to install. (To produce an unpacked app folder without an installer, use
`npm run pack` → `dist\win-unpacked\`.)

> Regenerating the icon: `npm run icon` rebuilds `build\icon.ico` from
> `build\icon.png`.

### Using your Claude key in the installed app

The packaged app has no bundled `.env` (your key never ships inside it). To use
the Claude brain after installing, do **one** of:

- Set a system environment variable `ANTHROPIC_API_KEY`, **or**
- Drop a `.env` file (containing `ANTHROPIC_API_KEY=sk-ant-...`) into either the
  install folder (next to `UtopiaBot JARVIS.exe`) or
  `%APPDATA%\UtopiaBot JARVIS\`.

Ollama needs no key and works in the installed app as soon as it's running
locally.

## Pushing updates to installed apps

The app checks for updates on launch, downloads any newer version in the
background, and applies it on restart (or via the "Restart & update now" button
JARVIS shows). Updates are served from **GitHub Releases** via
[electron-updater](https://www.electron.build/auto-update).

**One-time setup:**

1. Create a GitHub repo for this project and push the code.
2. In [package.json](package.json) → `build.publish`, set `owner` to your GitHub
   username and `repo` to the repo name (currently `YOUR_GITHUB_USERNAME` /
   `utopiabot-jarvis-edition`).
3. Create a GitHub **Personal Access Token** with `repo` scope and expose it as
   `GH_TOKEN` in your shell.

**Each time you want to ship an update:**

1. Bump `version` in [package.json](package.json) (e.g. `0.1.0` → `0.1.1`).
2. Publish:

   ```powershell
   $env:GH_TOKEN="ghp_xxx"
   npm run release
   ```

   This builds the installer and uploads it (plus `latest.yml`) to a GitHub
   release. Installed apps pick it up automatically on their next launch.

> Auto-update only runs in the installed (packaged) app — it's a no-op in
> `npm start`. Unsigned builds update fine; the version comparison comes from
> `latest.yml`, so always bump `version` before releasing.

## How it routes a request

```
You speak/type
      │
      ▼
parseCommand()  ──matches──▶  local command (time / open app / search) ──▶ spoken reply
      │ no match
      ▼
Claude brain (streaming)  ──▶  streamed reply  ──▶  text-to-speech
```

## Project layout

| Path | Purpose |
| --- | --- |
| [src/main/main.js](src/main/main.js) | Electron main process — window, IPC, permissions |
| [src/main/preload.js](src/main/preload.js) | Safe `window.jarvis` bridge (context-isolated) |
| [src/main/claude.js](src/main/claude.js) | Anthropic SDK brain — streaming |
| [src/main/ollama.js](src/main/ollama.js) | Local Ollama brain — model list + streaming |
| [src/main/ollama-server.js](src/main/ollama-server.js) | Auto-starts the Ollama server in a terminal |
| [src/main/updater.js](src/main/updater.js) | Auto-update via GitHub Releases |
| [src/main/settings.js](src/main/settings.js) | Settings load/save (userData/settings.json) |
| [src/main/system.js](src/main/system.js) | Live CPU/RAM/GPU stats |
| [src/renderer/settings.html](src/renderer/settings.html) | Settings window (8 sections) |
| [src/renderer/settings-renderer.js](src/renderer/settings-renderer.js) | Settings window logic |
| [src/main/persona.js](src/main/persona.js) | Shared JARVIS system prompt |
| [src/main/files.js](src/main/files.js) | Sandboxed file-read tools (self-access) |
| [src/main/commands.js](src/main/commands.js) | Local command handlers |
| [src/renderer/index.html](src/renderer/index.html) | HUD markup |
| [src/renderer/styles.css](src/renderer/styles.css) | Stark HUD styling |
| [src/renderer/reactor.js](src/renderer/reactor.js) | Arc-reactor canvas animation |
| [src/renderer/renderer.js](src/renderer/renderer.js) | Chat, voice, visualizer, routing |

## Notes & limitations

- **Voice recognition** uses the browser Web Speech API. Depending on your
  Electron build it may require a network connection; if it's unavailable you'll
  see a notice and can still type. Text-to-speech works offline.
- The API key lives only in the main process (never exposed to the renderer).
- Customize JARVIS's personality in the `SYSTEM_PROMPT` in
  [src/main/claude.js](src/main/claude.js), or add commands in
  [src/main/commands.js](src/main/commands.js) and the matching patterns in
  `parseCommand()` in [src/renderer/renderer.js](src/renderer/renderer.js).

## Ideas to extend

- Real system stats (CPU/RAM) via `systeminformation`.
- Tool use: let Claude call your local commands directly.
- A global hotkey + tray icon so JARVIS is always a keystroke away.
- Wake-word ("Hey JARVIS") for fully hands-free activation.
