# FreeAgent

**English** | [Italiano](README.it.md)

A Windows desktop app that turns the **free web chats** of AI providers (DeepSeek, Qwen, ...) into agents that read and edit files on your PC,
run commands, use [MCP](https://modelcontextprotocol.io) servers (including a headless Blender) and skills, and can hand work to **sub-agents** running on other chats.

- **No API, no API key, no paid plan.** You log in by hand to the free chat inside the app; FreeAgent then drives that page like a user would.
- **You stay in control.** Every file change and every shell command asks first (with the diff or the command), checkpoints let you roll back, and a task can be stopped at any time.
- **Sub-agents in parallel**, each in its own chat, with limits so the free sites are not hammered.
- **Agents can check their own work**: render a PowerPoint/HTML file to images in the background and have a chat that can see look at them.
- **Add MCP servers in two clicks**: paste the JSON, command or URL from any MCP server's README, switch servers on and off, try them.

> The interface is in Italian for now. The tested providers are **DeepSeek** and **Qwen**; Meta AI, Kimi, GLM, ChatGPT (free) and Arena are listed but are not "ready" until someone captures their page selectors (see [Adding a provider](#adding-a-provider)).

## Requirements

| | Minimum | Recommended |
|---|---|---|
| OS | Windows 10 64-bit | Windows 11 64-bit (developed and tested here) |
| RAM | 4 GB | 8 GB or more (the app embeds Chromium; every headless Blender adds about 250 MB) |
| Disk | 500 MB (downloaded app) | 1.5 GB if you build from source (about 600 MB of dependencies) |
| Internet | yes | yes |
| Account | a free account on one supported chat (DeepSeek or Qwen) | two, to try sub-agents on different providers |

Only if you install **from source**: [Node.js](https://nodejs.org) 22.12 or newer (the installer can fetch it for you).
Optional: [Git for Windows](https://git-scm.com) (the `bash` tool uses Git Bash), [Blender](https://www.blender.org) 5.x (the included `blender` MCP server), Microsoft PowerPoint (rendering `.pptx` previews).

## Install

**Option A: download the app (easiest).**
1. Open the [latest release](https://github.com/schirripabruno8-web/freeagent/releases/latest) and download `FreeAgent-win-x64.zip`.
2. Extract it anywhere (for example `C:\FreeAgent`) and run `FreeAgent.exe`.
3. The app is not code-signed, so Windows SmartScreen may warn: click **More info**, then **Run anyway**.

**Option B: from source, one double click.**
1. Download the repository (**Code > Download ZIP**, then extract) or `git clone` it.
2. Double-click **`Install.bat`**. It checks Node.js (offering to install it with winget), installs the dependencies, builds the app, can put a shortcut on the Desktop, and starts it.
3. Next time use the Desktop shortcut or `FreeAgent.bat`.

**Option C: by hand.**
```bash
npm ci
node node_modules/electron/install.js   # downloads the Electron binary (about 110 MB, once)
npm run build
npx electron .
```

### First run
1. Pick a provider in the left column, then **log in on the page shown on the right** (email and password: Google sign-in is refused inside embedded browsers; Meta AI signs in through Facebook or Instagram, which the app allows).
2. Choose a working folder, write a task, press **Start**. The default mode, "Chiedi prima" (ask first), asks before every change.
3. The **Strumenti** tab holds the MCP servers, skills and checkpoints; **Recenti** reopens past chats.

## Privacy and safety

- **Your logins never leave your PC and are not part of the app.** They live in the embedded browser's profile in `%APPDATA%\freeagent`, like in any browser. FreeAgent itself does not read or store passwords, cookies or tokens. The downloadable zip is built by GitHub Actions on a clean machine from this source, so it cannot contain anyone's accounts.
- **If you share a copy of the app, never copy `%APPDATA%\freeagent`**: it holds your logins, chat history and settings.
- Chat history is kept locally (`%APPDATA%\freeagent\history`); the only network traffic is the provider pages you chose and the MCP servers you configured. A server on an `https://` address is marked "in rete" (what you send it leaves your PC).
- MCP results and web page text are treated as **untrusted data**: if one reads like instructions, the next change or command asks for confirmation even in auto modes.
- An MCP server is a program that runs on your PC with your permissions: add only ones you trust.
- The app itself opens no network port; the MCP servers it starts (such as Blender) listen on `127.0.0.1` only.

## Disclaimer

Automating a website's chat interface may violate that provider's terms of service. FreeAgent never rotates or creates accounts, bypasses captchas or usage limits, or spoofs the browser's identity: when a limit is reached it stops or switches to another provider. You use it with your own accounts, at your own risk. It is not affiliated with, or endorsed by, any provider. The software is provided as is, under the MIT license.

## Documentation

The detailed guide (permissions, sub-agents, skills, MCP, render/look, history, adding a provider) is in Italian: [README.it.md](README.it.md).

## Adding a provider

Page selectors are never invented: they come from the real page. With the app closed: `npm run inspect -- <provider>`, log in by hand, run **Inspect > Cattura automatica (2 min)** and write two long messages to the model. The files in `inspect-out/` are redacted (no message text, chat titles or input values), but read them before sharing; then add `config/selectors/<provider>.json`. See the [Italian guide](README.it.md#aggiungere-un-provider) for the details.

## Development

```bash
npm test             # unit and integration tests (vitest)
npm run typecheck
npm run build        # out/main, out/preload, out/renderer
npm run pack         # release/win-unpacked/FreeAgent.exe (close the app first)
```

Stack: Electron 44, TypeScript, electron-vite, React, zod, vitest, the official MCP SDK. Layout: `contracts/` shared types, `src/main/` main process (agent loop, tools, permissions, MCP pool, providers), `src/renderer/` UI, `config/` provider registry, selectors, MCP and agent profiles, `skills/` bundled skills, `tests/` fixtures and integration tests.
Releases are built by `.github/workflows/release.yml` when a `v*` tag is pushed.

## License

[MIT](LICENSE). The bundled `ponytail` skill comes from [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail) (MIT, see `skills/ponytail/LICENSE`). The Blender add-on `dcc-mcp-blender` (MIT) is a separate download made only if you ask for it.
