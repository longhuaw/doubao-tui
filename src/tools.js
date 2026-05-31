// ---------------------------------------------------------------------------
// ArkTerm — Tools: 5 local tool implementations + OpenAI function schemas
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const chalk = require('chalk');
const inquirer = require('inquirer');
const { diffLines } = require('diff');
const { TextDecoder } = require('util');
const { isSafeCommand, isHighRisk, quickConfirm } = require('./security');

// ── Encoding helpers ────────────────────────────────────────────────────────
const gbkDecoder = new TextDecoder('gbk');

/**
 * Decode a raw Buffer → string using the correct locale encoding.
 * On Windows consoles (cmd.exe) output is typically GBK/CP936;
 * on Unix the stdout pipe produces UTF-8 natively.
 */
function decodeOutput(chunk) {
  if (!Buffer.isBuffer(chunk)) return String(chunk);
  return process.platform === 'win32'
    ? gbkDecoder.decode(chunk, { stream: true })
    : chunk.toString('utf-8');
}

// Lazy-loaded mammoth for .docx parsing
let _mammoth = null;
function getMammoth() {
  if (!_mammoth) {
    try {
      _mammoth = require('mammoth');
    } catch {
      return null;
    }
  }
  return _mammoth;
}

const WORKSPACE = process.cwd();
const os = require('os');

// Resolve path: handle ~, %VAR%, and relative paths
function resolvePath(filePath) {
  let p = filePath || '.';
  // Expand ~ to home directory
  if (p.startsWith('~')) {
    p = path.join(os.homedir(), p.slice(1));
  }
  // Expand %ENV_VAR% on Windows
  if (process.platform === 'win32') {
    p = p.replace(/%([^%]+)%/g, (_, name) => process.env[name] || `%${name}%`);
  }
  // Resolve: if already absolute, path.resolve returns it as-is
  return path.resolve(WORKSPACE, p);
}

// Auto-approve mode — toggled via /auto command in REPL
let autoApprove = false;
function setAutoApprove(val) { autoApprove = val; }
function getAutoApprove() { return autoApprove; }

// ── WeChat bridge (set by main.js after monitor init) ──────────────────────

let _wechatMonitor = null;
let _sendWechatMessageFn = null;

/**
 * Inject the WeChatMonitor instance so tools can call switchAndReceive.
 * Called once by main.js after WeChatMonitor is created.
 */
function setWeChatMonitor(monitor) {
  _wechatMonitor = monitor;
}

/**
 * Inject the sendWechatMessage function (from wechat.js).
 * Called once by main.js so send_wechat_message tool can send messages.
 */
function setSendWechatMessage(fn) {
  _sendWechatMessageFn = fn;
}

// ── Tool implementations ──────────────────────────────────────────────────

/**
 * View the directory structure of the workspace (depth ≤ 3).
 */
function viewStructure(rootDir) {
  const root = rootDir || WORKSPACE;
  const lines = [];
  lines.push(`📁 ${root}`);

  function walk(dir, prefix, depth) {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Sort: dirs first, then alphabetical
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory())
        return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const isLast = i === entries.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      lines.push(prefix + connector + entry.name + (entry.isDirectory() ? '/' : ''));
      if (entry.isDirectory()) {
        const nextPrefix = prefix + (isLast ? '    ' : '│   ');
        walk(path.join(dir, entry.name), nextPrefix, depth + 1);
      }
    }
  }

  walk(root, '', 0);
  return lines.join('\n');
}

/**
 * Check whether a resolved absolute path is within allowed boundaries.
 * Prevents path-traversal attacks and access to sensitive system directories.
 */
function isPathSafe(absPath) {
  const allowedRoots = [
    WORKSPACE,
    os.homedir(),
    path.join(os.homedir(), 'Desktop'),
    path.join(os.homedir(), 'Documents'),
    path.join(os.homedir(), 'Downloads'),
  ];
  const resolved = path.resolve(absPath);
  for (const root of allowedRoots) {
    // resolved must either equal root or start with root + separator
    if (resolved === root || resolved.startsWith(root + path.sep)) {
      return true;
    }
  }
  return false;
}

/**
 * Read a file (UTF-8) and return its content.
 *
 * Behaviour by size:
 *   ≤ 200 lines  → full content
 *   201–1000 lines → head 50 + tail 50 preview
 *   > 1000 lines  → structure summary only (refuse full read)
 *   > 500 KB raw  → refused (likely binary)
 */
async function readFile(filePath) {
  try {
    const abs = resolvePath(filePath);

    // ── Safety: path traversal guard ─────────────────────────────────
    if (!isPathSafe(abs)) {
      return (
        `[Error] 路径越权: ${filePath}\n` +
        `  解析路径: ${abs}\n` +
        `  只允许访问工作区 (${WORKSPACE}) 及用户目录下的文件。`
      );
    }

    if (!fs.existsSync(abs)) {
      return `[Error] 文件不存在: ${filePath}`;
    }

    const stat = fs.statSync(abs);
    if (!stat.isFile()) {
      return `[Error] 不是文件: ${filePath}`;
    }

    // ── .docx handler: extract plain text via mammoth ──────────────────
    const ext = path.extname(abs).toLowerCase();
    if (ext === '.docx') {
      const mammoth = getMammoth();
      if (!mammoth) {
        return `[Error] 无法解析 .docx 文件：mammoth 库未安装。请运行 npm install mammoth`;
      }
      try {
        const buffer = fs.readFileSync(abs);
        const result = await mammoth.extractRawText({ buffer });
        const text = result.value || '';
        const lines = text.split('\n');
        const totalLines = lines.length;
        const totalChars = text.length;

        if (result.messages && result.messages.length > 0) {
          const warnings = result.messages
            .filter((m) => m.type === 'warning')
            .slice(0, 3)
            .map((m) => m.message)
            .join('; ');
          if (warnings) {
            return (
              `📄 ${filePath} (.docx → text, ${totalLines} lines, ${totalChars} chars)\n` +
              `⚠ 解析警告: ${warnings}\n\n${text.slice(0, 8000)}${text.length > 8000 ? '\n… (content truncated)' : ''}`
            );
          }
        }

        return (
          `📄 ${filePath} (.docx → text, ${totalLines} lines, ${totalChars} chars)\n\n${text.slice(0, 8000)}${text.length > 8000 ? '\n… (content truncated)' : ''}`
        );
      } catch (err) {
        return `[Error] .docx 解析失败: ${err.message || err}`;
      }
    }

    // ── Safety: size guard (likely binary or data file) ──────────────
    const MAX_BYTES = 500 * 1024; // 500 KB
    if (stat.size > MAX_BYTES) {
      return (
        `[Refused] 文件过大 (${(stat.size / 1024).toFixed(1)} KB)，可能是二进制或数据文件。\n` +
        `  如需查看内容，请使用 execute_command 运行: head -n 100 "${abs}"`
      );
    }

    const content = fs.readFileSync(abs, 'utf-8');
    const lines = content.split('\n');
    const totalLines = lines.length;
    const totalChars = content.length;

    // ── > 1000 lines: refuse full read, return structure summary ─────
    if (totalLines > 1000) {
      // Detect language / file type from extension
      const ext = path.extname(abs).toLowerCase();
      const langMap = {
        '.js': 'JavaScript', '.ts': 'TypeScript', '.py': 'Python',
        '.java': 'Java', '.go': 'Go', '.rs': 'Rust', '.c': 'C', '.cpp': 'C++',
        '.h': 'C/C++ Header', '.json': 'JSON', '.md': 'Markdown', '.txt': 'Text',
        '.html': 'HTML', '.css': 'CSS', '.yaml': 'YAML', '.yml': 'YAML',
        '.toml': 'TOML', '.xml': 'XML', '.sh': 'Shell', '.bat': 'Batch',
      };
      const lang = langMap[ext] || (ext ? ext.slice(1).toUpperCase() : 'Unknown');

      // Count non-empty lines
      const nonEmpty = lines.filter((l) => l.trim().length > 0).length;

      // Sample first and last few lines for context
      const headSample = lines.slice(0, 5).map((l, i) => `  ${i + 1}: ${l.slice(0, 120)}`).join('\n');
      const tailSample = lines.slice(-5).map((l, i) => `  ${totalLines - 4 + i}: ${l.slice(0, 120)}`).join('\n');

      return (
        `📄 ${filePath} — 文件结构摘要\n` +
        `  类型: ${lang}  总行数: ${totalLines}  非空行: ${nonEmpty}  大小: ${(stat.size / 1024).toFixed(1)} KB\n` +
        `  ⚠ 文件过大，已拒绝完整读取。请使用以下方式操作：\n` +
        `    1. 使用 patch_file 对目标片段进行精确修改\n` +
        `    2. 使用 execute_command 运行命令查看特定行范围\n` +
        `    3. 使用 write_file 覆盖整个文件（谨慎）\n` +
        `\n─── 前 5 行 ───\n${headSample}\n` +
        `─── 后 5 行 ───\n${tailSample}`
      );
    }

    // ── 201–1000 lines: head + tail preview ─────────────────────────
    if (totalLines > 200) {
      const head = lines.slice(0, 50).join('\n');
      const tail = lines.slice(-50).join('\n');
      return (
        `📄 ${filePath} (${totalLines} lines, ${totalChars} chars)\n` +
        `─── HEAD (1-50) ───\n${head}\n` +
        `─── ... (${totalLines - 100} lines omitted) ───\n` +
        `─── TAIL (${totalLines - 49}-${totalLines}) ───\n${tail}`
      );
    }

    // ── ≤ 200 lines: full content ───────────────────────────────────
    return `📄 ${filePath} (${totalLines} lines, ${totalChars} chars)\n${content}`;
  } catch (err) {
    return `[Error] 读取文件失败: ${err.message || err}\n  文件: ${filePath}`;
  }
}

/**
 * Write (or overwrite) a file. Returns a confirmation string.
 * Supports both full content and patching instructions.
 */
function writeFile(filePath, content) {
  const abs = resolvePath(filePath);
  const dir = path.dirname(abs);
  const oldContent = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : '';
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(abs, content, 'utf-8');
  const stat = fs.statSync(abs);
  let diffOut = '';
  if (oldContent) {
    const changes = diffLines(oldContent, content);
    const added = changes.filter((c) => c.added).reduce((s, c) => s + c.value.split('\n').filter(Boolean).length, 0);
    const removed = changes.filter((c) => c.removed).reduce((s, c) => s + c.value.split('\n').filter(Boolean).length, 0);
    diffOut = `\n  ${chalk.green('+' + added)} ${chalk.red('-' + removed)} lines changed`;
  }
  return `✅ ${filePath} written (${stat.size} bytes).${diffOut}`;
}

/**
 * Apply a text replacement patch to an existing file.
 * Simulates the original Python `patch_file` logic.
 */
function patchFile(filePath, search, replace) {
  const abs = resolvePath(filePath);
  if (!fs.existsSync(abs)) {
    return `[Error] 文件不存在: ${filePath}`;
  }
  const original = fs.readFileSync(abs, 'utf-8');
  let matchIndex = original.indexOf(search);

  if (matchIndex === -1) {
    // Try trimming trailing whitespace per line
    const normalized = original.split('\n').map((l) => l.trimEnd()).join('\n');
    const searchNorm = search.split('\n').map((l) => l.trimEnd()).join('\n');
    matchIndex = normalized.indexOf(searchNorm);

    if (matchIndex !== -1) {
      // Map match position back to original — replace using normalized then
      const updated = normalized.replace(searchNorm, replace);
      const changes = diffLines(original, updated);
      const added = changes.filter((c) => c.added).reduce((s, c) => s + c.value.split('\n').filter(Boolean).length, 0);
      const removed = changes.filter((c) => c.removed).reduce((s, c) => s + c.value.split('\n').filter(Boolean).length, 0);
      fs.writeFileSync(abs, updated, 'utf-8');
      const stat = fs.statSync(abs);
      return `✅ ${filePath} patched (${stat.size} bytes, fuzzy whitespace match).\n  ${chalk.green('+' + added)} ${chalk.red('-' + removed)} lines changed`;
    }

    // Try to locate similar lines for a helpful error
    const searchFirstLine = search.split('\n')[0].trim();
    const lines = original.split('\n');
    const similar = lines
      .map((l, i) => ({ line: l, index: i }))
      .filter(({ line }) => line.includes(searchFirstLine.slice(0, 30)));
    if (similar.length > 0) {
      const hints = similar
        .slice(0, 3)
        .map(({ line, index }) => `  L${index + 1}: ${line.slice(0, 80)}`)
        .join('\n');
      return (
        `[Error] 未找到精确匹配。附近行:\n${hints}\n` +
        `请提供精确的原文片段（注意缩进格式）`
      );
    }

    return `[Error] 未找到匹配内容: "${search.slice(0, 60)}..."`;
  }

  const updated = original.slice(0, matchIndex) + replace + original.slice(matchIndex + search.length);
  if (updated === original) {
    return `[Error] 替换后无变化，请检查 search/replace 内容。`;
  }

  fs.writeFileSync(abs, updated, 'utf-8');
  const stat = fs.statSync(abs);

  // Generate diff summary
  const changes = diffLines(original, updated);
  const added = changes.filter((c) => c.added).reduce((s, c) => s + c.value.split('\n').filter(Boolean).length, 0);
  const removed = changes.filter((c) => c.removed).reduce((s, c) => s + c.value.split('\n').filter(Boolean).length, 0);

  return `✅ ${filePath} patched (${stat.size} bytes).\n  ${chalk.green('+' + added)} ${chalk.red('-' + removed)} lines changed`;
}

/**
 * Execute a shell command (with security gate).
 *
 * Uses spawn() with explicit UTF‑8 env vars and .setEncoding('utf‑8') on all
 * output streams.  No more chcp hacks — encoding is handled at the Node.js
 * pipe layer so we always receive valid UTF‑8 regardless of OS locale.
 */
async function executeCommand(command) {
  // ── Windows command translation ─────────────────────────────────────────
  if (process.platform === 'win32') {
    // ls → dir: strip -flags that don't map to Windows /flags
    command = command.replace(/^ls(\s+.*)?$/i, (_, trail) => {
      if (!trail) return 'dir';
      const cleaned = trail.replace(/(?:^|\s)--?\w+/g, '').replace(/\s+/g, ' ').trim();
      return cleaned ? `dir ${cleaned}` : 'dir';
    });
    // cat → type: same treatment
    command = command.replace(/^cat(\s+.*)?$/i, (_, trail) => {
      if (!trail) return 'type';
      const cleaned = trail.replace(/(?:^|\s)--?\w+/g, '').replace(/\s+/g, ' ').trim();
      return cleaned ? `type ${cleaned}` : 'type';
    });
  }

  // ── Security gate: high‑risk → immediate refusal ─────────────────────
  if (isHighRisk(command)) {
    return `[Security Refusal] This command is restricted for safety. 高危命令已被拦截: ${command.slice(0, 80)}`;
  }

  if (!isSafeCommand(command)) {
    return `[Blocked] 命令被安全模块拦截 (匹配黑名单)。`;
  }

  if (autoApprove) {
    console.log(chalk.dim(`\n  [auto] ${command}`));
  } else {
    // Single‑key confirmation for safe commands (y = approve)
    const ok = await quickConfirm(command);
    if (!ok) {
      return `[Denied] 用户未批准该命令。`;
    }
  }

  // ── Execution (spawn, fully UTF‑8) ─────────────────────────────────────
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, [], {
        cwd: WORKSPACE,
        shell: true,
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          PYTHONUTF8: '1',
          LANG: 'en_US.UTF-8',
          LC_ALL: 'en_US.UTF-8',
        },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      return resolve(
        `$ ${command}\n${chalk.red('Error:')} ${(err.message || String(err)).slice(0, 1000)}`
      );
    }

    // Do NOT call .setEncoding() — let chunks stay as raw Buffers.
    // We decode manually in on('close') with TextDecoder('gbk') on Windows
    // so Chinese system output (GBK/CP936) renders correctly.

    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const MAX_BYTES = 10 * 1024 * 1024; // 10 MB hard cap per stream

    child.stdout.on('data', (chunk) => {
      if (stdoutBytes < MAX_BYTES) {
        stdoutChunks.push(chunk);
        stdoutBytes += chunk.length;
      }
    });
    child.stderr.on('data', (chunk) => {
      if (stderrBytes < MAX_BYTES) {
        stderrChunks.push(chunk);
        stderrBytes += chunk.length;
      }
    });

    // 30-second timeout
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve(`$ ${command}\n${chalk.red('Error:')} Command timed out after 30s`);
    }, 30_000);

    child.on('close', (code) => {
      clearTimeout(timer);

      // Decode accumulated raw Buffers using the correct locale encoding
      const stdout = stdoutChunks.length > 0
        ? decodeOutput(Buffer.concat(stdoutChunks))
        : '';
      const stderr = stderrChunks.length > 0
        ? decodeOutput(Buffer.concat(stderrChunks))
        : '';

      const output = stdout || '(no output)';
      if (code === 0) {
        resolve(
          `$ ${command}\n${output.slice(0, 3000)}${output.length > 3000 ? '\n… (output truncated)' : ''}`
        );
      } else {
        const errMsg = stderr || `exit code ${code}`;
        resolve(
          `$ ${command}\n${chalk.red('Error:')} ${errMsg.slice(0, 1000)}${stdout ? `\n${stdout.slice(0, 1000)}` : ''}`
        );
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve(
        `$ ${command}\n${chalk.red('Error:')} ${(err.message || String(err)).slice(0, 1000)}`
      );
    });
  });
}

// ── Git Assistant ──────────────────────────────────────────────────────────

/**
 * Run a git command and return { stdout, stderr, code }.
 */
function runGit(args) {
  return new Promise((resolve) => {
    const child = spawn('git', args, {
      cwd: WORKSPACE,
      env: { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf-8');
    child.stderr.setEncoding('utf-8');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code: code ?? 1 }));
    child.on('error', (err) => resolve({ stdout: '', stderr: err.message, code: 1 }));
  });
}

/**
 * Analyse git diff output and generate an AngularJS‑convention commit message.
 */
function generateCommitMessage(diffText, statText) {
  const hasDiff = diffText && diffText.trim().length > 0;
  if (!hasDiff) return null;

  const lines = diffText.split('\n');
  const newFiles = [];
  const deletedFiles = [];
  const modifiedFiles = [];
  let currentFile = '';

  for (const line of lines) {
    // Track file names from diff headers
    const newFileMatch = line.match(/^\+\+\+ b\/(.+)$/);
    const delFileMatch = line.match(/^--- a\/(.+)$/);
    const delOnlyMatch = line.match(/^deleted file mode \d+$/);

    if (newFileMatch) currentFile = newFileMatch[1];
    if (delFileMatch && !currentFile) currentFile = delFileMatch[1];

    if (line.startsWith('new file mode') && currentFile) {
      newFiles.push(currentFile);
    }
    if (delOnlyMatch && currentFile) {
      deletedFiles.push(currentFile);
    }
    if (line.startsWith('index ') && currentFile && !newFiles.includes(currentFile) && !deletedFiles.includes(currentFile)) {
      if (!modifiedFiles.includes(currentFile)) modifiedFiles.push(currentFile);
    }
  }

  // Determine type of change
  const allChanged = [...new Set([...newFiles, ...modifiedFiles, ...deletedFiles])];
  let type = 'chore';
  let scope = '';

  // Heuristic: look at file extensions / paths
  const hasTests = allChanged.some((f) => /test|spec|__tests__/.test(f));
  const hasDocs = allChanged.some((f) => /\.md$|\.rst$|docs?\//.test(f));
  const hasConfig = allChanged.some((f) => /\.json$|\.ya?ml$|\.toml$|\.env/.test(f) && !f.includes('package-lock'));
  const hasSrc = allChanged.some((f) => /^src\/|^lib\/|\.js$|\.ts$|\.py$|\.go$|\.rs$/.test(f));
  const hasBuild = allChanged.some((f) => /Dockerfile|Makefile|\.github\//.test(f));
  const hasPkg = allChanged.some((f) => /package\.json$/.test(f));

  if (hasTests && allChanged.every((f) => /test|spec/.test(f))) {
    type = 'test';
    scope = '';
  } else if (hasDocs && allChanged.every((f) => /\.md$|docs?\//.test(f))) {
    type = 'docs';
  } else if (hasBuild && allChanged.length <= 2) {
    type = 'build';
  } else if (hasConfig && allChanged.length <= 2) {
    type = 'chore';
    scope = 'config';
  } else if (newFiles.length > 0 && deletedFiles.length === 0) {
    type = 'feat';
  } else if (deletedFiles.length > 0 && newFiles.length === 0) {
    type = 'refactor';
    scope = 'cleanup';
  } else if (hasSrc) {
    // Detect fix vs feat by looking for common fix keywords in the diff
    const combined = diffText.toLowerCase();
    if (/fix|bug|issue|crash|error|broken|regression/.test(combined)) {
      type = 'fix';
    } else if (/refactor|clean|simplif|extract|rename/.test(combined)) {
      type = 'refactor';
    } else if (/perf|optimize|faster|slow/.test(combined)) {
      type = 'perf';
    } else if (/style|format|whitespace|lint/.test(combined)) {
      type = 'style';
    } else {
      type = 'feat';
    }
  }

  // Build the subject line from changed files
  const fileNames = allChanged.map((f) => path.basename(f)).filter(Boolean);
  let subject = '';
  if (fileNames.length === 1 && newFiles.includes(allChanged[0])) {
    subject = `add ${fileNames[0]}`;
  } else if (fileNames.length === 1 && deletedFiles.includes(allChanged[0])) {
    subject = `remove ${fileNames[0]}`;
  } else if (fileNames.length === 1) {
    subject = `update ${fileNames[0]}`;
  } else if (fileNames.length <= 3) {
    subject = fileNames.join(', ');
  } else {
    subject = `${fileNames[0]} and ${fileNames.length - 1} other file(s)`;
  }

  // Format: type(scope): subject
  const header = scope ? `${type}(${scope}): ${subject}` : `${type}: ${subject}`;
  return header.slice(0, 72); // Conventional commit max header length
}

/**
 * Git assistant tool — status / diff / commit_all with AngularJS convention.
 */
async function gitAssistant(action) {
  // ── status ──────────────────────────────────────────────────────────────
  if (action === 'status') {
    const { stdout, stderr, code } = await runGit(['status', '--short', '--branch']);
    if (code !== 0) return `[Git Error] ${stderr || 'git status failed'}`;
    return stdout || '(clean — no changes)';
  }

  // ── diff ────────────────────────────────────────────────────────────────
  if (action === 'diff') {
    const staged = await runGit(['diff', '--staged', '--stat']);
    const unstaged = await runGit(['diff', '--stat']);
    const parts = [];
    if (staged.stdout) parts.push(`─── Staged ───\n${staged.stdout}`);
    if (unstaged.stdout) parts.push(`─── Unstaged ───\n${unstaged.stdout}`);
    return parts.join('\n\n') || '(no changes)';
  }

  // ── commit_all ──────────────────────────────────────────────────────────
  if (action === 'commit_all') {
    // 1. Check if there's anything to commit
    const status = await runGit(['status', '--porcelain']);
    if (!status.stdout) return '(nothing to commit — working tree clean)';

    // 2. Stage all changes
    const addResult = await runGit(['add', '.']);
    if (addResult.code !== 0) return `[Git Error] git add failed: ${addResult.stderr}`;

    // 3. Get the full diff for commit message generation
    const stagedDiff = await runGit(['diff', '--staged']);
    const statResult = await runGit(['diff', '--staged', '--stat']);

    // 4. Generate commit message
    const commitMsg = generateCommitMessage(stagedDiff.stdout, statResult.stdout);
    if (!commitMsg) return '[Git Error] Could not generate commit message — no changes detected.';

    // 5. Commit
    const commitResult = await runGit(['commit', '-m', commitMsg]);
    if (commitResult.code !== 0) {
      return `[Git Error] Commit failed: ${commitResult.stderr}\n(Changes are staged — run git commit manually)`;
    }

    return `✅ Committed: ${commitMsg}\n${statResult.stdout || ''}`;
  }

  return `[Error] 未知 git action: ${action}。支持: status, diff, commit_all`;
}

// ── WeChat Switch & Receive ─────────────────────────────────────────────────

/**
 * Switch WeChat to a target contact and return their latest messages.
 * Used by the AI agent when the user says "查看郭振杰的消息" etc.
 */
async function switchAndReceiveWechat(args) {
  if (!_wechatMonitor) {
    return '[WeChat] 微信监控模块未初始化。请确保 WeChat Monitor 已启动。';
  }

  const contact = args.contact || '';
  if (!contact) {
    return '[WeChat] 请指定联系人名称。用法: switch_and_receive_wechat { contact: "郭振杰" }';
  }

  const result = await _wechatMonitor.switchAndReceive(contact);

  if (result.status === 'scan_failed') {
    return `[WeChat] 扫描失败 — 无法读取微信 UIA 树。请确认微信已打开且聊天窗口可见。`;
  }

  if (result.status === 'not_running') {
    return '[WeChat] 微信未运行。请先启动微信并打开聊天窗口。';
  }

  if (result.status === 'window_not_found') {
    return '[WeChat] 检测到微信进程，但无法定位主窗口。请确保微信窗口未最小化到托盘。';
  }

  if (result.status === 'no_messages') {
    const availList = (result.availableContacts || []).slice(0, 15).join('、');
    return (
      `[WeChat] 已切换到联系人 "${contact}"，但当前窗口暂无消息。\n` +
      `  当前活跃联系人: ${result.activeContact || '未检测到'}\n` +
      `  匹配状态: ${result.contactMatched ? '✓ 已匹配' : '✗ 未精确匹配 — 请手动点击该联系人'}\n` +
      (availList ? `  可用联系人 (前15): ${availList}` : '')
    );
  }

  // Success — format messages
  const convo = result.conversation || [];
  const formatted = convo.slice(-20).map((m) => {
    const prefix = m.role === 'me' ? '🧑 [用户]' : '💬 [对方]';
    return `${prefix}: ${m.text}`;
  }).join('\n');

  return (
    `📱 微信 — ${result.activeContact || contact}\n` +
    `  消息数: ${result.messageCount}  聊天状态: ${result.chatOpen ? '开启' : '未知'}\n` +
    `  匹配: ${result.contactMatched ? '✓' : '⚠ 未精确匹配'}\n` +
    `─── 最近对话 ───\n${formatted || '(空)'}\n` +
    `─── 微信监控已进入快速轮询模式 (2.5s 间隔, 持续 2 分钟) ───`
  );
}

// ── WeChat Send Message ────────────────────────────────────────────────────

/**
 * Send a message to a WeChat contact by injecting text into the input box.
 * Uses UIA to locate the Edit control and SendKeys to type + Enter.
 */
async function sendWechatMessageTool(args) {
  if (!_sendWechatMessageFn) {
    return '[WeChat] 微信发送模块未初始化。请确保 WeChat Monitor 已启动。';
  }

  const contact = args.contact || '';
  const text = args.text || '';

  if (!contact) {
    return '[WeChat] 请指定联系人名称。用法: send_wechat_message { contact: "郭振杰", text: "好的" }';
  }

  if (!text || text.trim().length === 0) {
    return '[WeChat] 消息内容不能为空。';
  }

  const result = await _sendWechatMessageFn(contact, text);

  if (result.status === 'ok') {
    return `✅ 微信消息已发送给 "${contact}": "${text}"`;
  }

  return `[WeChat] 发送失败: ${result.error || '未知错误'}`;
}

// ── OpenAI Function‑Calling Schemas ───────────────────────────────────────

const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'view_structure',
      description:
        '查看工作区的目录结构（递归，最大深度 3 层）。排除 . 开头和 node_modules 目录。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '可选的子路径，默认为工作区根目录',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取工作区内的一个 UTF‑8 文件并返回内容预览（大文件只返回首尾）。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径（相对于工作区根目录）',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '创建或覆盖写入一个文件（自动创建父目录）。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径（相对于工作区根目录）',
          },
          content: {
            type: 'string',
            description: '文件完整内容',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'patch_file',
      description:
        '对已有文件执行精确的搜索‑替换操作。search 必须与原文精确匹配（包括缩进）。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: '文件路径（相对于工作区根目录）',
          },
          search: {
            type: 'string',
            description: '要被替换的原文片段（必须精确匹配，包括缩进）',
          },
          replace: {
            type: 'string',
            description: '替换后的新内容',
          },
        },
        required: ['path', 'search', 'replace'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'execute_command',
      description:
        '在操作系统 Shell 中执行命令。会自动检查安全黑名单并征求用户批准。超时 30 秒。',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的 Shell 命令',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git_assistant',
      description:
        'Git 辅助工具。status: 查看仓库状态。diff: 查看暂存/未暂存差异。commit_all: 自动分析修改内容生成 AngularJS 规范 commit message（feat/fix/chore/refactor...），执行 git add . && git commit -m。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'diff', 'commit_all'],
            description: 'status: 仓库状态, diff: 差异摘要, commit_all: 自动提交全部变更',
          },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'switch_and_receive_wechat',
      description:
        '微信消息工具。切换到指定联系人并实时接收其最新消息。当用户提到"查看XX的消息"、"接收微信"、"看下谁发了什么"时使用此工具。支持联系人名称模糊匹配。',
      parameters: {
        type: 'object',
        properties: {
          contact: {
            type: 'string',
            description: '要查看的联系人名称（支持模糊匹配），例如："郭振杰"、"张三"、"妈妈"',
          },
        },
        required: ['contact'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_wechat_message',
      description:
        '微信消息发送工具。直接向指定微信联系人发送一条文字消息。当用户说"帮我回复XX"、"给XX发一条消息说..."、"替我回XX一句..."时使用此工具。消息会自动注入微信输入框并发送。',
      parameters: {
        type: 'object',
        properties: {
          contact: {
            type: 'string',
            description: '接收消息的联系人名称，例如："郭振杰"、"张三"',
          },
          text: {
            type: 'string',
            description: '要发送的消息文本内容（简洁自然，15字以内为佳）',
          },
        },
        required: ['contact', 'text'],
      },
    },
  },
];

// ── Dispatch table ────────────────────────────────────────────────────────

const TOOL_DISPATCH = {
  view_structure: async (args) => viewStructure(args.path || WORKSPACE),
  read_file: async (args) => readFile(args.path),
  write_file: async (args) => writeFile(args.path, args.content),
  patch_file: async (args) => patchFile(args.path, args.search, args.replace),
  execute_command: async (args) => executeCommand(args.command),
  git_assistant: async (args) => gitAssistant(args.action),
  switch_and_receive_wechat: async (args) => switchAndReceiveWechat(args),
  send_wechat_message: async (args) => sendWechatMessageTool(args),
};

module.exports = {
  TOOL_SCHEMAS,
  TOOL_DISPATCH,
  setAutoApprove,
  getAutoApprove,
  setWeChatMonitor,
  setSendWechatMessage,
};
