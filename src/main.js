// ---------------------------------------------------------------------------
// ArkTerm — Terminal AI Agent Main Loop
// ---------------------------------------------------------------------------
let exitConfirmCount = 0;
let autoApprove = false; // /auto toggle: skip security prompts
const { stripVTControlCharacters } = require('util');
const fs = require('fs');
const path = require('path');
const os = require('os');
const chalk = require('chalk');
const boxen = require('boxen');
const readline = require('readline');
const { OpenAI } = require('openai');
const { ChatSession } = require('./session');
const { TOOL_SCHEMAS, TOOL_DISPATCH, setAutoApprove, setWeChatMonitor, setSendWechatMessage } = require('./tools');
const config = require('./config');
const { renderMarkdown, renderDiff, createSpinner } = require('./ui');
const { WeChatMonitor, sendWechatMessage } = require('./wechat');
const { MODEL_REGISTRY, state, ALIASES, switchModel, getCurrentDisplayName } = config;

// ── Constants ─────────────────────────────────────────────────────────────
const AGENT_MAX_TURNS = 5;
const DESKTOP = require('os').homedir() + (process.platform === 'win32' ? '\\Desktop' : '/Desktop');
/**
 * Build the SYSTEM_PROMPT with dynamic project context injected at the top.
 * Reads package.json (name, description, deps count) and directory tree (depth 2)
 * so the AI immediately understands the project without extra tool calls.
 */
function buildSystemPrompt() {
  let contextBlock = '';

  try {
    const pkgPath = path.join(process.cwd(), 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      const name = pkg.name || 'unknown';
      const desc = pkg.description || '';
      const deps = Object.keys(pkg.dependencies || {}).length;
      const devDeps = Object.keys(pkg.devDependencies || {}).length;
      contextBlock += `Project: ${name}${desc ? ' — ' + desc : ''} (${deps} deps, ${devDeps} devDeps)\n`;
    }
  } catch { /* ignore — not critical */ }

  // Directory tree (depth 2, top-level only)
  try {
    const cwd = process.cwd();
    const entries = fs.readdirSync(cwd, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules').map((e) => e.name);
    const files = entries.filter((e) => e.isFile() && !e.name.startsWith('.')).map((e) => e.name);
    if (dirs.length > 0 || files.length > 0) {
      contextBlock += `Top-level: dirs=[${dirs.join(', ')}] files=[${files.join(', ')}]\n`;
    }
  } catch { /* ignore */ }

  const contextHeader = contextBlock
    ? `Current Project Context:\n${contextBlock}`
    : '';

  return `${contextHeader}You are ArkTerm, an autonomous terminal AI agent running on Windows.

Important paths:
- Desktop: ${DESKTOP}
- Home: ${require('os').homedir()}
- Workspace: ${process.cwd()}

Tools available:
1. **view_structure** — view project directory tree (depth ≤ 3)
2. **read_file** — read a file (UTF-8), supports .docx via mammoth
3. **write_file** — create or overwrite a file (use full paths like ${DESKTOP}\\file.txt)
4. **patch_file** — search-and-replace edit
5. **execute_command** — run a shell command (high-risk commands auto-blocked)
6. **git_assistant** — git status/diff/commit with auto-generated AngularJS commit messages
7. **switch_and_receive_wechat** — 切换到指定微信联系人并接收实时消息（当用户提到"查看XX的消息"时使用）
8. **send_wechat_message** — 直接向指定微信联系人发送一条文字消息（当用户说"帮我回复XX"、"给XX发消息"时使用）

Rules:
- Respond in the SAME LANGUAGE as the user's message.
- For casual greetings, reply directly WITHOUT calling any tools.
- When writing files to the desktop, use the absolute path: ${DESKTOP}\\filename
- Read before you edit.
- Each turn is one tool call; you have up to 5 turns per request.
- After completing a coding task (files written or patched), PROACTIVELY ask the user whether they want to commit the changes using git_assistant.`;
}

// ── OpenAI Client Factory (cached, reflects current config state) ─────────

let _cachedClient = null;
let _cachedConfigKey = '';

const { HttpsProxyAgent } = require('https-proxy-agent');

function createClient() {
  const { apiKey, baseURL } = config.getClientConfig();
  const configKey = `${apiKey}::${baseURL}`;

  // Return cached client if config hasn't changed
  if (_cachedClient && _cachedConfigKey === configKey) {
    return _cachedClient;
  }

  const proxy = process.env.HTTPS_PROXY || process.env.http_proxy;

  // Create proxy agent with keepalive enabled
  const agent = proxy
    ? new HttpsProxyAgent(proxy, { keepAlive: true })
    : undefined;

  _cachedClient = new OpenAI({
    apiKey,
    baseURL,
    timeout: 60_000,
    maxRetries: 2,
    httpAgent: agent,
    httpsAgent: agent,
  });
  _cachedConfigKey = configKey;
  return _cachedClient;
}

// ── Shared input state (exposed for WeChat real‑time notification) ─────

/** Holds the live readLine state so WeChat callbacks can restore the prompt. */
const _inputState = { buf: '', pos: 0, display: null, promptStr: '', active: false };

/** WeChat quick-reply interception state machine.
 *  When AI generates a suggested reply while the user is typing:
 *   - active=true intercepts the NEXT keypress in readLine
 *   - Y/y → send message via sendWechatMessage, restore prompt
 *   - Any other key → dismiss, process key normally */
let _wechat = null;  // module-level for readLine and exit handlers
let _replyModeActive = false;
global.pendingReplies = [];  // [{ contact, text, originalMsg }]

function _renderReplyQueue() {
  process.stdout.write('\r\x1b[2K');
  console.log(chalk.cyan.bold('\n💡 [ArkTerm 待发队列]:'));
  global.pendingReplies.forEach((r, i) => {
    console.log(chalk.cyan(`  [${i + 1}] (${r.contact}): "${r.text}"`));
  });
  console.log(chalk.dim('  按对应数字键一键发送  |  按 [Enter] 或其他键清空队列'));
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Calculate the terminal display width of a string.
 * CJK / fullwidth characters count as 2 columns; ASCII as 1.
 * ANSI escape sequences are stripped before measurement.
 */
function visualWidth(str) {
  // Strip ANSI / VT control sequences first
  const plain = stripVTControlCharacters(str);
  let w = 0;
  for (const ch of plain) {
    const cp = ch.codePointAt(0);
    // Fullwidth forms, CJK, and other wide characters
    if (
      (cp >= 0x1100 && cp <= 0x115F) ||   // Hangul Jamo
      (cp >= 0x2329 && cp <= 0x232A) ||   // Misc technical
      (cp >= 0x2E80 && cp <= 0xA4CF) ||   // CJK Radicals … Yi
      (cp >= 0xA960 && cp <= 0xA97C) ||   // Hangul Jamo Extended-A
      (cp >= 0xAC00 && cp <= 0xD7A3) ||   // Hangul Syllables
      (cp >= 0xF900 && cp <= 0xFAFF) ||   // CJK Compatibility Ideographs
      (cp >= 0xFE10 && cp <= 0xFE19) ||   // Vertical forms
      (cp >= 0xFE30 && cp <= 0xFE6F) ||   // CJK Compatibility Forms
      (cp >= 0xFF00 && cp <= 0xFF60) ||   // Fullwidth Forms
      (cp >= 0xFFE0 && cp <= 0xFFE6) ||   // Fullwidth Signs
      (cp >= 0x1F300 && cp <= 0x1F64F) || // Misc Symbols & Pictographs
      (cp >= 0x1F900 && cp <= 0x1F9FF) || // Supplemental Symbols
      (cp >= 0x20000 && cp <= 0x2FFFD) || // CJK Extension B+
      (cp >= 0x30000 && cp <= 0x3FFFD)    // CJK Extension G+
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

// ── Stream & Live Display (boxen‑based real‑time panel) ───────────────────

async function streamWithPanel(client, messages, withTools, showBoyen = true) {
  const displayName = getCurrentDisplayName();
  const startTime = Date.now();
  let firstTokenTime = null;
  let totalChars = 0;
  let fullText = '';
  const toolCallsAcc = {};
  let lastBoxLineCount = 0;

  const body = {
    model: state.modelId,
    messages,
    stream: true,
    max_tokens: 8192,
    stream_options: { include_usage: true },
  };
  if (withTools) body.tools = TOOL_SCHEMAS;

  function buildBox(text, genSpeed, ttft, avgSpeed, chars) {
    const displayText = text || chalk.dim('streaming…');
    const metrics =
      chalk.dim('TTFT ') + chalk.cyan(ttft.toFixed(2) + 's') + '  ' +
      chalk.dim('Gen ') + chalk.bold.cyan(Math.round(genSpeed) + ' ch/s') + '  ' +
      chalk.dim('Avg ') + chalk.cyan(Math.round(avgSpeed) + ' ch/s') + '  ' +
      chalk.dim('⎸ ' + chars + ' chars');

    return boxen(
      displayText + '\n\n' + chalk.gray('─── Speed ───') + '\n' + metrics,
      {
        title: chalk.bold.green(displayName),
        borderStyle: 'round',
        borderColor: 'green',
        padding: 1,
        margin: 0,
      }
    );
  }

  function renderBox(text, genSpeed, ttft, avgSpeed, chars) {
    if (!showBoyen) return;
    const boxStr = buildBox(text, genSpeed, ttft, avgSpeed, chars);
    const lines = boxStr.split('\n');
    const lineCount = lines.length;
    if (lastBoxLineCount > 0) {
      process.stdout.write(`\x1b[${lastBoxLineCount - 1}A\x1b[J`);
      process.stdout.write(lines.slice(1).join('\n') + '\n');
    } else {
      process.stdout.write(boxStr + '\n');
    }
    lastBoxLineCount = lineCount;
  }

  function hideBox() {
    if (!showBoyen || lastBoxLineCount === 0) return;
    process.stdout.write(`\x1b[${lastBoxLineCount}A\x1b[J`);
    lastBoxLineCount = 0;
  }

  // Seed placeholder
  renderBox('', 0, 0, 0, 0);
  let lastRender = 0;
  let lastContent = '';
  const RENDER_INTERVAL = 80; // ms between renders

  const updateFn = (now) => {
    const elapsed = (now - startTime) / 1000;
    const ttft = firstTokenTime ? (firstTokenTime - startTime) / 1000 : elapsed;
    const genE = firstTokenTime ? (now - firstTokenTime) / 1000 : 0.001;
    const genS = genE > 0 ? totalChars / genE : 0;
    const avgS = elapsed > 0 ? totalChars / elapsed : 0;
    const displayText = fullText
      ? (totalChars > 200 ? '…' + fullText.slice(-200) : fullText)
      : '';

    // Only render when content changes
    if (displayText === lastContent && lastBoxLineCount > 0) {
      return;
    }
    lastContent = displayText;
    renderBox(displayText, genS, ttft, avgS, totalChars);
  };
  let spinner = null;
  try {
    const stream = await client.chat.completions.create(body);
    // Show spinner only while waiting for first actual data chunk
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta;
      const hasContent = delta?.content;
      const hasToolCalls = delta?.tool_calls?.length > 0;

      // Only record TTFT on first MEANINGFUL data — skip empty/heartbeat chunks
      // that some APIs (e.g. Volcengine Ark) send before real tokens
      if (!firstTokenTime && (hasContent || hasToolCalls)) {
        firstTokenTime = Date.now();
      }

      if (hasContent) {
        fullText += delta.content;
        totalChars += delta.content.length;
      }
      if (hasToolCalls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallsAcc[idx]) {
            toolCallsAcc[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          }
          if (tc.id) toolCallsAcc[idx].id = tc.id;
          if (tc.type) toolCallsAcc[idx].type = tc.type;
          if (tc.function?.name) toolCallsAcc[idx].function.name += tc.function.name;
          if (tc.function?.arguments) toolCallsAcc[idx].function.arguments += tc.function.arguments;
        }
      }

      // Check for truncation
      const reason = chunk.choices?.[0]?.finish_reason;
      if (reason === 'length') {
        fullText += '\n\n[⚠ Response truncated — consider reducing context or increasing max_tokens]';
      }

      const now = Date.now();
      if (now - lastRender > RENDER_INTERVAL) {
        lastRender = now;
        updateFn(now);
      }
    }

    // Final render
    updateFn(Date.now());
    hideBox();

    // Build tool calls list (preserve insertion order from object)
    const toolCalls = Object.values(toolCallsAcc)
      .map((tc) => ({
        id: tc.id,
        type: tc.type || 'function',
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));

    return { fullText, toolCalls };
  } catch (err) {
    hideBox();
    const msg = err.message || String(err);
    console.error(chalk.red.bold('\n✗ API Error: ') + msg);
    return { fullText: '', toolCalls: [] };
  }
}

// ── Raw‑Mode Input Reader (handles Tab for model switching) ───────────────

async function readLine(promptStr) {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const stdout = process.stdout;

    require('readline').emitKeypressEvents(stdin);
    const wasRaw = stdin.isRaw;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();

    let buf = '';
    let pos = 0;

    function display() {
      const left = promptStr + buf.slice(0, pos);
      const right = buf.slice(pos);
      const cursorChar = right.length > 0 ? right[0] : ' ';

      readline.cursorTo(stdout, 0);
      readline.clearLine(stdout, 0);
      stdout.write(left + chalk.inverse(cursorChar) + right.slice(1));

      // Use visual (column) width for cursor positioning — CJK chars are 2 cols
      const promptCols = visualWidth(promptStr);
      const leftCols = visualWidth(buf.slice(0, pos));
      readline.cursorTo(stdout, promptCols + leftCols);

      // ── Expose state for WeChat interrupt/restore ──────────────────
      _inputState.buf = buf;
      _inputState.pos = pos;
      _inputState.display = display;
      _inputState.promptStr = promptStr;
      _inputState.active = true;
    }

    display();

    function cleanup() {
      _inputState.active = false;
      if (stdin.isTTY && wasRaw === false) stdin.setRawMode(false);
    }

    function onKeypress(ch, key) {
      if (!key) return;

      // ── WeChat reply queue interception ──────────────────────────
      if (_replyModeActive) {
        const digit = parseInt(ch, 10);
        if (!isNaN(digit) && digit >= 1 && digit <= 9 && (digit - 1) < global.pendingReplies.length) {
          // User pressed a number matching a pending reply
          const idx = digit - 1;
          const reply = global.pendingReplies[idx];
          global.pendingReplies.splice(idx, 1);

          sendWechatMessage(reply.contact, reply.text).then((res) => {
            stdout.write('\r\x1b[2K');
            if (res.status === 'ok') {
              console.log(chalk.green(`  [WeChat] sent to ${reply.contact}${res.method ? ` (${res.method})` : ''}`));
            } else {
              console.log(chalk.red(`  [WeChat] send failed for ${reply.contact}: ${res.error || 'unknown error'}`));
              global.pendingReplies.splice(Math.min(idx, global.pendingReplies.length), 0, reply);
            }

            _replyModeActive = global.pendingReplies.length > 0;
            if (_replyModeActive) _renderReplyQueue();
            if (_inputState.display) _inputState.display();
          }).catch((err) => {
            stdout.write('\r\x1b[2K');
            console.log(chalk.red(`  [WeChat] send failed for ${reply.contact}: ${err.message || err}`));
            global.pendingReplies.splice(Math.min(idx, global.pendingReplies.length), 0, reply);
            _replyModeActive = true;
            _renderReplyQueue();
            if (_inputState.display) _inputState.display();
          });

          stdout.write('\r\x1b[2K');
          console.log(chalk.dim(`  [WeChat] sending to ${reply.contact}...`));

          if (global.pendingReplies.length === 0) {
            _replyModeActive = false;
            display();
          } else {
            _renderReplyQueue();
            if (_inputState.display) _inputState.display();
          }
          return;
        }

        // Enter or any other key — clear entire queue
        _replyModeActive = false;
        global.pendingReplies.length = 0;
        stdout.write('\r\x1b[2K');
        display();
        return;
      }

      switch (key.name) {
        case 'return':
        case 'enter':
          stdin.removeListener('keypress', onKeypress);
          cleanup();
          stdout.write('\n');
          resolve(buf);
          return;

        case 'tab':
          stdin.removeListener('keypress', onKeypress);
          cleanup();
          stdout.write('\n');
          resolve('__TAB__');
          return;

        case 'backspace':
          if (pos > 0) {
            buf = buf.slice(0, pos - 1) + buf.slice(pos);
            pos--;
            display();
          }
          return;

        case 'delete':
          if (pos < buf.length) {
            buf = buf.slice(0, pos) + buf.slice(pos + 1);
            display();
          }
          return;

        case 'left':
          if (pos > 0) { pos--; display(); }
          return;

        case 'right':
          if (pos < buf.length) { pos++; display(); }
          return;

        case 'home':
          pos = 0;
          display();
          return;

        case 'end':
          pos = buf.length;
          display();
          return;

        case 'u':
          if (key.ctrl) {
            buf = '';
            pos = 0;
            display();
            return;
          }
          break;

        case 'c':
          if (key.ctrl) {
            if (exitConfirmCount === 0) {
              exitConfirmCount = 1;
              stdout.write(chalk.yellow('\n ⚠ 再按一次 Ctrl+C 即可退出 ArkTerm.'));
              setTimeout(() => { exitConfirmCount = 0; }, 5000);
              return;
            } else {
              stdin.removeListener('keypress', onKeypress);
              cleanup();
              stdout.write('\n');
              resolve(null);
              if (_wechat) _wechat.stop();  // kill PowerShell child before exit
              process.exit(0);
            }
          }
          break;

        case 'd':
          if (key.ctrl) {
            stdin.removeListener('keypress', onKeypress);
            cleanup();
            stdout.write('\n');
            resolve('');
            return;
          }
          break;
      }

      if (ch && ch.length === 1 && ch.charCodeAt(0) >= 32) {
        buf = buf.slice(0, pos) + ch + buf.slice(pos);
        pos++;
        display();
      }
    }

    stdin.on('keypress', onKeypress);
  });
}

// ── Text‑based Tool Call Fallback ────────────────────────────────────────

/**
 * When a model doesn't support native OpenAI tool_calls, it may embed
 * JSON tool calls inside the text response. This parser extracts them.
 * Returns { cleanedText, toolCalls }.
 */
function extractTextToolCalls(text) {
  const TOOL_NAMES = ['execute_command', 'read_file', 'write_file', 'patch_file', 'view_structure', 'git_assistant'];
  const toolCalls = [];
  const toRemove = []; // [startIdx, endIdx] ranges to strip

  for (const toolName of TOOL_NAMES) {
    const namePattern = new RegExp(`"name"\\s*:\\s*"${toolName}"`, 'g');
    let match;
    while ((match = namePattern.exec(text)) !== null) {
      // Find the enclosing { … } by balancing braces
      const startIdx = text.lastIndexOf('{', match.index);
      if (startIdx === -1) continue;

      let depth = 0;
      let endIdx = -1;
      for (let i = startIdx; i < text.length; i++) {
        const ch = text[i];
        if (ch === '{') { depth++; }
        else if (ch === '}') {
          depth--;
          if (depth === 0) { endIdx = i; break; }
        } else if (ch === '"') {
          // Skip string contents
          for (i++; i < text.length && text[i] !== '"'; i++) {
            if (text[i] === '\\') i++; // skip escaped
          }
        }
      }
      if (endIdx === -1) continue;

      const jsonStr = text.slice(startIdx, endIdx + 1);
      try {
        const parsed = JSON.parse(jsonStr);
        if (parsed.name && typeof parsed.parameters === 'object') {
          toolCalls.push({
            id: 'fallback_' + toolCalls.length,
            type: 'function',
            function: {
              name: parsed.name,
              arguments: JSON.stringify(parsed.parameters),
            },
          });
          toRemove.push([startIdx, endIdx + 1]);
        }
      } catch {
        // Malformed JSON — skip silently
      }
    }
  }

  // Strip extracted JSON blocks from the text (longest-first to avoid index shifts)
  toRemove.sort((a, b) => a[0] - b[0]);
  let cleaned = text;
  for (let i = toRemove.length - 1; i >= 0; i--) {
    const [s, e] = toRemove[i];
    cleaned = cleaned.slice(0, s) + cleaned.slice(e);
  }
  // Collapse whitespace left by removal
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  return { cleanedText: cleaned, toolCalls };
}

// ── Process Response (Agent Loop) ─────────────────────────────────────────

async function processAssistantResponse(client, session) {
  for (let turn = 0; turn < AGENT_MAX_TURNS; turn++) {
    const messages = session.getCompactMessages();

    // Only show streaming panel on first turn; suppress on subsequent turns
    const showBox = turn === 0;
    if (!showBox) {
      console.log(chalk.dim('  …'));
    }

    const { fullText, toolCalls } = await streamWithPanel(client, messages, true, showBox);

    // Fallback: parse text-embedded JSON tool calls
    let effectiveToolCalls = toolCalls;
    let displayText = fullText;
    if (toolCalls.length === 0 && fullText) {
      const fallback = extractTextToolCalls(fullText);
      if (fallback.toolCalls.length > 0) {
        effectiveToolCalls = fallback.toolCalls;
        displayText = fallback.cleanedText || fullText;
        console.log(chalk.yellow(`  ⚡ Fallback: ${effectiveToolCalls.length} tool call(s) from text.`));
      }
    }

    const assistantMsg = { role: 'assistant', content: displayText || null };
    if (effectiveToolCalls.length > 0) {
      assistantMsg.tool_calls = effectiveToolCalls;
    }
    session.appendMessage(assistantMsg);

    if (effectiveToolCalls.length === 0) {
      // Final response — render markdown
      if (displayText) {
        console.log(renderMarkdown(displayText));
      } else {
        console.log(chalk.dim('  (done)'));
      }
      return;
    }

    // ── Tool icons (Claude Code style compact output) ──────────────────
    const TOOL_ICONS = {
      view_structure: '📁',
      read_file: '📖',
      write_file: '✏️',
      patch_file: '🔧',
      execute_command: '⚡',
      git_assistant: '🔀',
    };

    // Execute each tool call
    for (const tc of effectiveToolCalls) {
      const funcName = tc.function.name;
      let args = {};
      try { args = JSON.parse(tc.function.arguments || '{}'); } catch { args = {}; }

      const icon = TOOL_ICONS[funcName] || '🔹';
      process.stdout.write(chalk.cyan(`  ${icon} ${funcName}...`));

      const handler = TOOL_DISPATCH[funcName];
      let result;
      if (handler) {
        try {
          result = await handler(args);
        } catch (err) {
          result = `[Tool Error] ${err.message || err}`;
        }
      } else {
        result = `[Unknown tool] ${funcName}`;
      }

      // Single-line status + brief preview
      if (result.startsWith('[Error]') || result.startsWith('[Blocked]') || result.startsWith('[Denied]') || result.startsWith('[Refused]')) {
        process.stdout.write(chalk.red(' [Failed]\n'));
        process.stdout.write(chalk.dim(`     ${result.replace(/\n/g, ' ').slice(0, 120)}\n`));
      } else {
        const firstLine = result.replace(/\n/g, ' ').slice(0, 80);
        process.stdout.write(chalk.green(' [Done]'));
        process.stdout.write(chalk.dim(`  ${firstLine}\n`));
      }

      const maxResultLen = 8000;
      if (result.length > maxResultLen) {
        result = result.slice(0, maxResultLen) + `\n… (truncated, ${result.length} chars total)`;
      }

      session.appendMessage({
        role: 'tool',
        tool_call_id: tc.id,
        content: result,
      });
    }

    if (turn === AGENT_MAX_TURNS - 1) {
      console.log(chalk.yellow(`\n  ⚠ Max turns (${AGENT_MAX_TURNS}) reached.`));
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  // 1. Validate configuration (runs interactive wizard if needed)
  await config.validate();

  // 2. Init state from env
  config.initFromEnv();

  // 3. Welcome banner
  const header = [
    '',
    chalk.hex('#7B68EE').bold('   █████╗ ██████╗ ██╗  ██╗████████╗'),
    chalk.hex('#7B68EE').bold('  ██╔══██╗██╔══██╗██║ ██╔╝╚══██╔══╝'),
    chalk.hex('#7B68EE').bold('  ███████║██████╔╝█████╔╝    ██║   '),
    chalk.hex('#7B68EE').bold('  ██╔══██║██╔══██╗██╔═██╗    ██║   '),
    chalk.hex('#7B68EE').bold('  ██║  ██║██║  ██║██║  ██╗   ██║   '),
    chalk.hex('#7B68EE').bold('  ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝   ╚═╝   '),
    '',
    chalk.dim('    Doubao · DeepSeek · Claude  —  Terminal AI Agent'),
    '',
  ].join('\n');

  console.log(boxen(header, {
    padding: 1,
    margin: 0,
    borderStyle: 'round',
    borderColor: '#7B68EE',
    align: 'center',
  }));
  console.log(chalk.gray('   Press ') + chalk.cyan.bold('Tab') + chalk.gray(' to switch models  ·  ') + chalk.cyan.bold('/help') + chalk.gray(' for commands'));
  console.log('');

  // 4. Launch REPL
  const session = new ChatSession();
  session.appendMessage({ role: 'system', content: buildSystemPrompt() });

  // 5. Start WeChat monitor — polls local WeChat window via UI Automation
  _wechat = null;
  function _initWeChat() {
    try {
      const client = createClient();
      _wechat = new WeChatMonitor({
        client,
        modelId: state.modelId,
        interval: 15000, // poll every 15 s
        onNewMessage: (contact, text) => {
          // ── Real-time interrupt: fires IMMEDIATELY on detection ────
          const now = new Date();
          const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
          if (!_inputState.active) {
            console.log(`\n🔔 [WeChat 实时提醒] ${contact}: ${text}  (${time})`);
            return;
          }

          const savedDisplay = _inputState.display;

          // Erase the current input line
          process.stdout.write('\r\x1b[2K');
          // Print real-time notification
          console.log(`\n🔔 [WeChat 实时提醒] ${contact}: ${text}  (${time})`);

          // Restore the prompt + partial input
          if (savedDisplay) {
            savedDisplay();
          }
        },
        onMessage: (friendName, message, reply) => {
          // ── Push to numbered reply queue ─────────────────────────
          if (_inputState.active) {
            global.pendingReplies.push({ contact: friendName, text: reply, originalMsg: message });
            _replyModeActive = true;
            _renderReplyQueue();
            if (_inputState.display) _inputState.display();
          } else {
            console.log(chalk.cyan(`\n🤖 [ArkTerm 建议回复] (${friendName}): "${reply}"`));
          }
        },
        onStatus: (text) => {
          // Only print status if REPL is idle (not in middle of input)
          if (!_inputState.active) {
            console.log(chalk.dim(`  ${text}`));
          }
        },
      });
      _wechat.start();
      setWeChatMonitor(_wechat);
      setSendWechatMessage(sendWechatMessage);
    } catch (err) {
      console.error(chalk.red(`🔥 [WeChat] 初始化失败: ${err.message}`));
      console.error(chalk.red(`   ${err.stack || '(无调用栈)'}`));
    }
  }
  _initWeChat();

  while (true) {
    const currentModelKey = state.currentModelKey;
    const modelDisplay = getCurrentDisplayName();
    const promptColors = {
      doubao: chalk.hex('#7B68EE'),
      deepseek: chalk.hex('#4FC3F7'),
      claude: chalk.hex('#FF9E80'),
    };
    const colorFn = promptColors[currentModelKey] || chalk.white;
    const promptStr = colorFn(`(${modelDisplay}) You ❯ `);

    let userInput = await readLine(promptStr);

    if (userInput === '__TAB__') {
      // Cycle to next available model
      const keys = Object.keys(MODEL_REGISTRY);
      const curIdx = keys.indexOf(currentModelKey);
      let switched = false;
      for (let i = 1; i <= keys.length; i++) {
        const nextKey = keys[(curIdx + i) % keys.length];
        const display = switchModel(nextKey);
        if (display) {
          console.log(chalk.green(`  Switched to ${display}`));
          if (_wechat) { _wechat.setModelId(state.modelId); _wechat.setClient(createClient()); }
          switched = true;
          break;
        }
      }
      if (!switched) {
        console.log(chalk.yellow('  No other model configured.'));
      }
      continue;
    }

    if (userInput === null) {
      // Ctrl+C
      console.log(chalk.dim('^C'));
      continue;
    }

    if (userInput === '') {
      // Empty line
      continue;
    }

    const trimmed = userInput.trim();

    // ── Built-in commands ──
    if (trimmed.startsWith('/')) {
      const parts = trimmed.slice(1).split(/\s+/);
      const cmd = parts[0].toLowerCase();

      if (cmd === 'exit' || cmd === 'quit' || cmd === 'q') {
        console.log(chalk.dim('\n  Bye.'));
        break;
      }

      if (cmd === 'help' || cmd === 'h') {
        const modelList = config.listAvailableModels();
        const autoStatus = autoApprove ? chalk.green('ON (auto-approve)') : chalk.yellow('OFF (ask)');
        console.log(`
${chalk.bold('Commands')}
  ${chalk.cyan('/model [name]')}   Switch model (doubao/db, deepseek/ds, claude/cl)
  ${chalk.cyan('/auto')}     Toggle auto-approve: ${autoStatus}
  ${chalk.cyan('/clear')}    Clear conversation history
  ${chalk.cyan('/save')}     Save conversation to ~/.arkterm_history.json
  ${chalk.cyan('/help')}     Show this help
  ${chalk.cyan('/exit')}     Exit ArkTerm
  ${chalk.cyan('Tab')}       Cycle through available models

${chalk.bold('Models')}
${modelList}
`);
        continue;
      }

      if (cmd === 'auto') {
        autoApprove = !autoApprove;
        setAutoApprove(autoApprove);
        const status = autoApprove ? chalk.green('ON — commands execute without prompt') : chalk.yellow('OFF — each command requires approval');
        console.log(`  Auto-approve: ${status}`);
        continue;
      }

      if (cmd === 'model' || cmd === 'switch') {
        const target = parts[1];
        if (!target) {
          console.log(chalk.yellow('  Usage: /model <name>  (doubao/db, deepseek/ds, claude/cl)'));
          continue;
        }
        const display = switchModel(target);
        if (display) {
          console.log(chalk.green(`  Switched to ${display}`));
          console.log(chalk.dim(`  Endpoint: ${state.baseUrl}`));
          if (_wechat) { _wechat.setModelId(state.modelId); _wechat.setClient(createClient()); }
        } else {
          console.log(chalk.yellow(`  Unknown model: ${target}. Try: doubao, deepseek, claude`));
        }
        continue;
      }

      if (cmd === 'clear') {
        session.clearHistory();
        session.appendMessage({ role: 'system', content: buildSystemPrompt() });
        console.log(chalk.green('  Conversation cleared.'));
        continue;
      }

      if (cmd === 'save') {
        const histPath = path.join(os.homedir(), '.arkterm_history.json');
        try {
          const hist = JSON.stringify(session.getMessages(), null, 2);
          fs.writeFileSync(histPath, hist, 'utf-8');
          console.log(chalk.green('  History saved to ~/.arkterm_history.json'));
        } catch (err) {
          console.log(chalk.red(`  Save failed: ${err.message}`));
        }
        continue;
      }

      console.log(chalk.yellow(`  Unknown command: ${cmd}. Type /help for available commands.`));
      continue;
    }

    // ── Process user message ──
    session.addUserMessage(trimmed);

    // Agent mode: always include tools, let the model decide
    await processAssistantResponse(createClient(), session);
  }

  // ── Graceful WeChat cleanup ───────────────────────────────────────────
  if (_wechat) _wechat.stop();

  // Restore stdin
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}

// ── Entry ─────────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error(chalk.red.bold('\n✗ Fatal Error:'), err);
  process.exitCode = 1;
});
