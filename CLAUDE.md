# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

ArkTerm is a multi-model terminal AI agent (CLI) built in pure Node.js. It provides an interactive REPL that connects to Doubao (Volcengine Ark), DeepSeek, and Claude models via the OpenAI-compatible SDK. The agent has 8 tools (view directory, read/write/patch files, execute shell commands, git assistant, WeChat switch-and-receive, WeChat send message) and uses OpenAI function calling for tool orchestration.

## Commands

```bash
# Start (development)
npm start

# Syntax check on all source files
npm test

# Install dependencies
npm install

# Bump version & publish (git tag triggers CI npm publish)
npm version patch   # or minor / major
git push --tags
```

## Architecture

```
bin/index.js          # CLI entry: require('../src/main.js')
src/
  main.js             # REPL loop, streaming display (boxen), agent loop, raw-mode input, text fallback parser, dynamic system prompt builder
  config.js           # Env loading, model registry, interactive setup wizard (inquirer), model switching
  session.js          # ChatSession — in-memory message history with sliding-window compaction
  security.js         # Command blacklist (high-risk → immediate refusal; moderate → blocked), single-key confirm prompt
  tools.js            # 8 tool implementations + resolvePath() + isPathSafe() + OpenAI function-calling schemas + dispatch table
  ui.js               # Markdown rendering (marked + highlight.js), diff display (diff), spinner (ora)
  wechat.js           # WeChat UIA monitor — persistent PowerShell child process, AI reply generation, message send/switch
wechat_radar.ps1      # PowerShell persistent radar script — polls WeChat UIA tree, outputs JSON lines
```

## Key Design Decisions

- **All models use the OpenAI SDK** (`openai` npm package). Claude is accessed via an OpenAI-compatible proxy, not the Anthropic SDK.
- **Agent mode is always on**: Tools are always included in API calls; the model decides whether to use them (no intent detection gating). Max 5 turns per request (`AGENT_MAX_TURNS`).
- **OpenAI client is cached**: The client is created once and reused until config changes (model switch). Proxy agents use `keepAlive: true` to avoid TCP+TLS reconnect per request.
- **Streaming display**: `streamWithPanel()` uses boxen for a real-time panel showing the last 200 chars of output + TTFT/Gen/Avg speed metrics. Renders only when content changes, throttled to ~80ms intervals. Only the first agent turn shows the boxen panel; subsequent turns show a compact `…` indicator.
- **Dynamic system prompt**: `buildSystemPrompt()` reads `package.json` (name, description, deps) and top-level directory listing at startup, injecting project context into the system message so the AI understands the project without extra tool calls.
- **Raw-mode input**: Custom `readLine()` using `readline.emitKeypressEvents` + raw mode for Tab/Ctrl+C handling and inline editing with CJK-aware cursor positioning (`visualWidth()`). Supports Ctrl+U (clear line), Ctrl+D (EOF), Home/End, left/right arrows. WeChat reply queue interception is integrated: number keys send queued AI-suggested replies.
- **Model switching**: Tab cycles through available models (skips unconfigured ones). Each model entry in `MODEL_REGISTRY` maps to env vars (`*_API_KEY`, `*_MODEL`). Aliases: `db`→doubao, `ds`→deepseek, `cl`→claude.
- **Config persistence**: `~/.arkterm.env` (set by wizard), with `.env` in CWD as override. Both are loaded via dotenv.
- **Tool call fallback**: When a model doesn't support native function calling, `extractTextToolCalls()` parses JSON tool calls embedded in the text response via brace-balancing.
- **Markdown rendering**: Pure text responses are rendered through `marked` with `highlight.js` syntax highlighting for code blocks, converted to terminal-compatible chalk-colored output.
- **patch_file fuzzy matching**: Tolerates trailing whitespace differences by normalizing line endings before matching. Falls back to similar-line hints when no exact match is found. Returns diff stats (lines added/removed).
- **Path resolution + safety**: `resolvePath()` expands `~` to home directory, `%ENV_VAR%` on Windows, and resolves relative paths against the workspace. `isPathSafe()` restricts file operations to workspace, home, Desktop, Documents, and Downloads directories — prevents path-traversal attacks.
- **Windows encoding**: Commands are executed via `spawn()` with raw Buffer collection. Output is decoded using `TextDecoder('gbk')` on Windows (for Chinese system locale) and UTF-8 elsewhere. `ls`/`cat` are auto-translated to `dir`/`type` on Windows. No `chcp` hacks — encoding is handled at the Node.js pipe layer.
- **read_file guards**: Files >500KB are refused (likely binary). Files >1000 lines return structure summary only (language, line count, head/tail samples). Files 201–1000 lines return head 50 + tail 50. `.docx` files are parsed via mammoth library for plain-text extraction.
- **Auto-approve mode**: `/auto` command toggles command execution without user confirmation. Tools check `getAutoApprove()` before prompting.
- **Session compaction**: `ChatSession.getCompactMessages()` triggers when messages exceed 15. Builds a context summary from truncated middle messages (tracking file ops, commands, errors) and keeps the last 6 messages as a reasoning window intact.

## Tools (8 total)

| Tool | File | Description |
|------|------|-------------|
| `view_structure` | tools.js | Directory tree up to depth 3 (skips dotfiles, node_modules) |
| `read_file` | tools.js | Read UTF-8 files with size-aware previews; `.docx` via mammoth |
| `write_file` | tools.js | Create/overwrite files (auto-creates parent dirs) |
| `patch_file` | tools.js | Exact search-and-replace with fuzzy whitespace fallback |
| `execute_command` | tools.js | Shell command with 30s timeout, security gate, user approval |
| `git_assistant` | tools.js | `status`/`diff`/`commit_all` with auto-generated AngularJS commit messages |
| `switch_and_receive_wechat` | tools.js → wechat.js | Switch to a WeChat contact and fetch their latest messages via UIA |
| `send_wechat_message` | tools.js → wechat.js | Send a text message to a WeChat contact via UIA injection |

## WeChat Integration

- **Persistent monitor**: `WeChatMonitor` spawns a long-running PowerShell child (`wechat_radar.ps1`) that polls the WeChat UIA tree. Output is streamed as JSON lines via readline.
- **Real-time notification**: New messages fire `onNewMessage` callback which interrupts the REPL input line, prints the message, then restores the prompt.
- **AI reply generation**: New messages trigger `_generateAIReply()` which builds a few-shot prompt from the current conversation + user persona + style profile, calling the current model with low max_tokens (60).
- **Reply queue**: AI suggestions are pushed to `global.pendingReplies[]`. The user presses a number key to send one, or Enter/any other key to dismiss all.
- **Contact switching**: `switchAndReceive()` kills the persistent process, runs a one-shot UIA PowerShell script to locate and select the target contact, then respawns the persistent monitor in fast-poll mode (2.5s interval for 2 min).
- **Message sending**: Three-stage fallback: UIA button invoke → PostMessage Enter → foreground SendKeys. Respects `ARKTERM_WECHAT_BACKGROUND_ONLY=1` env var to disable foreground fallback.
- **Self-send echo suppression**: `_sentHistory` per-contact map suppresses self-sent messages from being re-detected.
- **Exit cleanup**: On process exit, WeChat window is restored from any legacy WS_EX_LAYERED ghost mode, lingering PowerShell children are taskkilled, and temp files are removed.

## REPL Commands

- `/auto` — Toggle auto-approve mode (skip security prompts for commands)
- `/model <name>` — Switch model (doubao/db, deepseek/ds, claude/cl)
- `/clear` — Clear conversation history
- `/save` — Save conversation to `~/.arkterm_history.json`
- `/help` — Show available commands and model list
- `/exit` — Exit ArkTerm
- `Tab` — Cycle through available models
- `Ctrl+C` × 2 — Exit (first press warns, second within 5s exits)

## CI/CD

- `.github/workflows/publish.yml` — auto-publishes to npm on `v*` tag push. Requires `NPM_TOKEN` secret.
- `.env` — template file checked into repo; actual secrets go in `~/.arkterm.env` or a gitignored local `.env`.
