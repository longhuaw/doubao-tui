# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

ArkTerm is a multi-model terminal AI agent (CLI) built in pure Node.js. It provides an interactive REPL that connects to Doubao (Volcengine Ark), DeepSeek, and Codex models via the OpenAI-compatible SDK. The agent has 5 local tools (view directory, read/write/patch files, execute shell commands) and uses OpenAI function calling for tool orchestration.

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
  main.js             # REPL loop, streaming display (boxen), agent loop, raw-mode input, text fallback parser
  config.js           # Env loading, model registry, interactive setup wizard (inquirer), model switching
  session.js          # ChatSession — in-memory message history array
  security.js         # Command blacklist patterns (isSafeCommand); requestUserPermission exists but is unused
  tools.js            # 5 tool implementations + resolvePath() + OpenAI function-calling schemas + dispatch table
  ui.js               # Markdown rendering (marked + highlight.js), diff display (diff), spinner (ora)
```

## Key Design Decisions

- **All models use the OpenAI SDK** (`openai` npm package). Codex is accessed via an OpenAI-compatible proxy, not the Anthropic SDK.
- **Agent mode is always on**: Tools are always included in API calls; the model decides whether to use them (no intent detection gating). Max 5 turns per request (`AGENT_MAX_TURNS`).
- **OpenAI client is cached**: The client is created once and reused until config changes (model switch). Proxy agents use `keepAlive: true` to avoid TCP+TLS reconnect per request.
- **Streaming display**: `streamWithPanel()` uses boxen for a real-time panel showing the last 200 chars of output + TTFT/Gen/Avg speed metrics. Renders only when content changes, throttled to ~80ms intervals. Only the first agent turn shows the boxen panel; subsequent turns show a compact `…` indicator.
- **Raw-mode input**: Custom `readLine()` using `readline.emitKeypressEvents` + raw mode for Tab/Ctrl+C handling and inline editing with CJK-aware cursor positioning (`visualWidth()`). Supports Ctrl+U (clear line), Ctrl+D (EOF), Home/End, left/right arrows.
- **Model switching**: Tab cycles through available models (skips unconfigured ones). Each model entry in `MODEL_REGISTRY` maps to env vars (`*_API_KEY`, `*_MODEL`). Aliases: `db`→doubao, `ds`→deepseek, `cl`→Codex.
- **Config persistence**: `~/.arkterm.env` (set by wizard), with `.env` in CWD as override. Both are loaded via dotenv.
- **Tool call fallback**: When a model doesn't support native function calling, `extractTextToolCalls()` parses JSON tool calls embedded in the text response via brace-balancing.
- **Markdown rendering**: Pure text responses are rendered through `marked` with `highlight.js` syntax highlighting for code blocks, converted to terminal-compatible chalk-colored output.
- **patch_file fuzzy matching**: Tolerates trailing whitespace differences by normalizing line endings before matching. Returns diff stats (lines added/removed).
- **Path resolution** (`resolvePath()` in tools.js): Expands `~` to home directory, `%ENV_VAR%` on Windows, and resolves relative paths against the workspace. Used by all file tools.
- **Windows encoding**: Commands executed on Windows are prefixed with `chcp 65001 > nul &&` to force UTF-8 output, preventing GBK mojibake from cmd.exe.
- **Auto-approve mode**: `/auto` command toggles command execution without user confirmation. Tools check `getAutoApprove()` before prompting.

## REPL Commands

- `/auto` — Toggle auto-approve mode (skip security prompts for commands)
- `/model <name>` — Switch model (doubao/db, deepseek/ds, Codex/cl)
- `/clear` — Clear conversation history
- `/save` — Save conversation to `~/.arkterm_history.json`
- `/help` — Show available commands and model list
- `/exit` — Exit ArkTerm
- `Tab` — Cycle through available models
- `Ctrl+C` × 2 — Exit (first press warns, second within 5s exits)

## CI/CD

- `.github/workflows/publish.yml` — auto-publishes to npm on `v*` tag push. Requires `NPM_TOKEN` secret.
- `.env` — template file checked into repo; actual secrets go in `~/.arkterm.env` or a gitignored local `.env`.
