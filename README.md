# ArkTerm

**[English](README.md) | [中文](README.zh-CN.md)**

🚀 Multi-Model Terminal AI Agent — Doubao (Volcengine) · DeepSeek

ArkTerm is a pure Node.js terminal AI agent that connects to multiple LLMs via the OpenAI-compatible SDK, providing an interactive REPL with 8 built-in tools for file operations, shell execution, Git assistance, and **real-time WeChat message monitoring with AI auto-reply**.

## Features

- **Pure Node.js**: No Python required. One-command npm installation. All dependencies are pure JS.
- **Cross-Platform**: Auto-detects Windows / macOS / Linux, adapts `dir`/`type` vs `ls`/`cat`, handles GBK encoding on Windows.
- **AI Agent Mode**: The model autonomously decides which tools to invoke, with up to 5 reasoning turns per request.
- **8 Built-in Tools**:
  - `view_structure` — Directory tree listing
  - `read_file` — Read files (with `.docx` parsing, large-file smart truncation)
  - `write_file` — Create/overwrite files (auto-creates parent dirs)
  - `patch_file` — Exact search-and-replace (whitespace-tolerant fuzzy matching)
  - `execute_command` — Shell command execution (security blacklist + user confirmation)
  - `git_assistant` — Git status/diff/commit-all (auto-generated AngularJS-style commit messages)
  - `switch_and_receive_wechat` — Switch to a WeChat contact and fetch recent messages
  - `send_wechat_message` — Send a text message to a WeChat contact
- **Streaming Display**: Real-time `boxen` panel showing last 200 chars of output plus TTFT / generation speed / average speed.
- **Markdown Rendering**: AI responses are rendered via `marked` + `highlight.js` with syntax-highlighted code blocks, converted to terminal-colored output.
- **Deep WeChat Integration**:
  - Persistent PowerShell child process polls the WeChat UIA tree for real-time message detection
  - AI auto-generates replies (learns user chat style + conversation context)
  - Press a number key to send, Enter to dismiss the queue
  - Pure background mode (`ARKTERM_WECHAT_BACKGROUND_ONLY=1`): never pops up or steals focus on incoming messages
  - Physical mouse-click simulation for reliable contact switching
- **Session Compaction**: Sliding-window compaction when messages exceed 15 — keeps operation summary + last 6 messages as reasoning window.
- **Security**: Command blacklist (high-risk → immediate refusal, moderate → blocked), path operations restricted to workspace/home/Desktop/Documents/Downloads.
- **Config Persistence**: Interactive setup wizard on first run, config saved to `~/.arkterm.env`, overridable by a local `.env`.

## Quick Start

Requires [Node.js (v18+)](https://nodejs.org/).

```bash
# Global install
npm install -g arkterm

# Launch
arkterm

# Or local development
git clone https://github.com/longhuaw/ArkTerm.git
cd ArkTerm
npm install
npm start
```

The first run launches an interactive wizard to configure API keys for each model.

## Configuration

### Environment Variables

Config is stored in `~/.arkterm.env`, with optional CWD `.env` override.

```bash
# Doubao (Volcengine Ark)
VOLC_API_KEY=your_api_key
DOUBAO_ENDPOINT_ID=your_endpoint_id

# DeepSeek
DEEPSEEK_API_KEY=your_api_key
DEEPSEEK_MODEL=deepseek-chat

# WeChat features (optional)
ARKTERM_WECHAT_BACKGROUND_ONLY=1  # Pure background: never pop up WeChat on incoming messages
```

All models use the OpenAI-compatible SDK uniformly.

### Model Aliases

| Alias | Model |
|-------|-------|
| `doubao` / `db` | Doubao (Volcengine) |
| `deepseek` / `ds` | DeepSeek |

## Usage

### REPL Commands

| Command | Description |
|---------|-------------|
| `/auto` | Toggle auto-approve mode (skip security confirmation for commands) |
| `/model <name>` | Switch model (`db` / `ds` or full name) |
| `/clear` | Clear conversation history |
| `/save` | Save conversation to `~/.arkterm_history.json` |
| `/help` | Show help and model list |
| `/exit` | Exit ArkTerm |
| `Tab` | Cycle through available models |
| `Ctrl+C` × 2 | First press warns, second within 5s exits |

### WeChat Features

WeChat integration uses Windows UIAutomation (UIA) to monitor and operate WeChat PC. Requires Windows with WeChat PC running.

**Message Notification**: When a new WeChat message arrives, the terminal interrupts the input line to display the notification. AI instantly generates a short reply suggestion.

```
🔔 [WeChat] 小华: What's for dinner?

💡 [ArkTerm Pending]:
  [1] (小华): "Cafeteria, too lazy to go out"
  Press number key to send  |  Press Enter to dismiss
```

**Sending**: Press a number key (1-9) to send the corresponding AI-suggested reply. Multiple replies are queued and sent sequentially.

**Contact Switching**: The AI can use `switch_and_receive_wechat` to switch to a specific contact and fetch conversation history for context-aware replies.

**Pure Background Mode**: Set `ARKTERM_WECHAT_BACKGROUND_ONLY=1` — receiving messages never pops up the WeChat window or steals focus. Only user-initiated sends briefly activate WeChat, then restore the previous foreground window.

### AI Agent Tools

In Agent mode, all 8 tools are always available; the model decides autonomously whether to invoke them. Tool calls use OpenAI function calling protocol, with a text-parsing fallback for models without native support.

## Architecture

```
bin/index.js          # CLI entry
src/
  main.js             # REPL loop, streaming display (boxen), agent loop, raw-mode input
  config.js           # Env loading, model registry, interactive setup wizard (inquirer)
  session.js          # ChatSession — in-memory message history with sliding-window compaction
  security.js         # Command blacklist + user confirmation prompt
  tools.js            # 8 tool implementations + path resolution/safety + function-calling schemas
  ui.js               # Markdown rendering (marked + highlight.js) + diff display + spinner (ora)
  wechat.js           # WeChat UIA monitor — persistent PowerShell child + AI reply generation + send/switch
wechat_radar.ps1      # PowerShell persistent radar — polls WeChat UIA tree, outputs JSON lines
```

## Development

```bash
npm install          # Install dependencies
npm start            # Start in development mode
npm test             # Syntax check on all source files
npm version patch    # Bump version (git tag triggers automatic npm publish)
git push --tags
```

## CI/CD

`.github/workflows/publish.yml` — auto-publishes to npm on `v*` tag push. Requires `NPM_TOKEN` secret.

## Contributing

Issues and Pull Requests are welcome.

## License

MIT
