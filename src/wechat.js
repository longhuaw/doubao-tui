// ---------------------------------------------------------------------------
// ArkTerm — WeChat: persistent PowerShell monitor + one-shot contact switch
// ---------------------------------------------------------------------------
const { spawn } = require('child_process');
const readline = require('readline');
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Paths to physical PowerShell scripts ───────────────────────────────────
const _radarScriptPath = path.resolve(__dirname, '..', 'wechat_radar.ps1');
const _cleanupScriptPath = path.join(os.tmpdir(), 'arkterm-cleanup.ps1');

// ── User Persona (generic — no hardcoded names) ──────────────────────────

const USER_PERSONA = `你是当前操作终端与微信的账号所有者（以下简称"用户"）。
你需要以该用户的身份和口吻，代替他回复微信消息。

口吻规则（务必严格遵守）：
- 口吻要绝对自然、口语化，像真人朋友聊天
- 回复控制在15字以内，多用短句
- 偶尔用"哈"、"行"、"晚点看"、"嗯"、"okk"这类词
- 严禁使用"您好"、"请问有什么可以帮您"、"亲"等淘宝客服词汇
- 严禁使用"当然可以"、"很高兴"、"非常抱歉"等机器人用语
- 可以用程序员黑话（bug、部署、merge、跑通了之类的）
- 对方求助时给实质建议，不说废话
- 最重要的是：回复风格必须与用户过往消息高度一致`;

// ── Per-contact sent history — prevents self-send echo in single chat ──────
const _sentHistory = new Map();

// ── Local fallbacks ──────────────────────────────────────────────────────

const LOCAL_FALLBACKS = [
  '晚点看，现在在忙',
  '行，等会说',
  'okk',
  '截图发我',
  '嗯，知道了',
  '哈，正常操作',
  '别慌，问题不大',
  '食堂，懒得出去',
  '在写代码，晚点回',
  '好，马上',
];

function isOwnPreview(text) {
  return /^(你|我|Me|You)\s*[:：]/i.test((text || '').trim());
}

function stripOwnPreviewPrefix(text) {
  return (text || '').trim().replace(/^(你|我|Me|You)\s*[:：]\s*/i, '').trim();
}

function isIgnoredWechatContact(contact) {
  return /^(微信|WeChat|通讯录|发现|朋友圈|视频号|搜一搜|小程序|设置|看一看|搜狗输入法|表情|收藏|卡包|相册|直播|视频|文件传输助手|微信支付|公众号|服务号|订阅号)$/i
    .test((contact || '').trim());
}

// ── Dynamic style profile builder ─────────────────────────────────────────

function buildStyleProfile(myMessages) {
  if (!myMessages || myMessages.length === 0) return '';
  const msgs = myMessages.filter((m) => m && m.trim().length > 0);
  if (msgs.length < 2) return '';

  const totalLen = msgs.reduce((s, m) => s + m.length, 0);
  const avgLen = Math.round(totalLen / msgs.length);

  let endsWithPeriod = 0, endsWithQuestion = 0, endsWithExclaim = 0;
  let endsWithEmoji = 0, noEnding = 0;
  const emojiRe = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u;

  for (const m of msgs) {
    const last = m.slice(-1);
    if (last === '。' || last === '.') endsWithPeriod++;
    else if (last === '？' || last === '?') endsWithQuestion++;
    else if (last === '！' || last === '!') endsWithExclaim++;
    else if (emojiRe.test(m.slice(-2))) endsWithEmoji++;
    else noEnding++;
  }

  const total = msgs.length;
  const parts = [];
  parts.push(`平均字数: ${avgLen}字`);

  const maxEnding = Math.max(endsWithPeriod, endsWithQuestion, endsWithExclaim, endsWithEmoji, noEnding);
  if (noEnding === maxEnding && noEnding > total * 0.3) {
    parts.push('句末习惯: 不爱加标点，直接结束');
  } else if (endsWithPeriod > total * 0.3) {
    parts.push('句末习惯: 常用句号结尾');
  } else if (endsWithExclaim > total * 0.2) {
    parts.push('句末习惯: 爱用感叹号');
  } else if (endsWithQuestion > total * 0.2) {
    parts.push('句末习惯: 常用问号');
  }

  if (avgLen <= 5) parts.push('风格: 极度简短，惜字如金');
  else if (avgLen <= 12) parts.push('风格: 简短精练');
  else if (avgLen <= 25) parts.push('风格: 正常聊天长度');
  else parts.push('风格: 偶尔会发较长消息');

  const samples = msgs.slice(-5).map((m) => `"${m.slice(0, 30)}"`).join('、');
  parts.push(`近期发言示例: ${samples}`);

  return `\n【用户历史聊天风格画像】\n${parts.join('；')}。\n请完全克隆以上风格回复。`;
}

// ═══════════════════════════════════════════════════════════════════════════
// One-shot PowerShell script (for contact switching)
// ═══════════════════════════════════════════════════════════════════════════

function buildUiaScript(targetContact) {
  const escaped = (targetContact || '').replace(/'/g, "''");
  return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$PSDefaultParameterValues['*:Encoding'] = 'utf8'
$targetContact = '${escaped}'
Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue

# ── Win32 ShowWindowAsync for silent restore ─────────────────────────
$monWin32Code = @"
using System;
using System.Runtime.InteropServices;
public class MonWin32 {
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
"@
try { Add-Type -TypeDefinition $monWin32Code -ErrorAction SilentlyContinue } catch { }

$proc = Get-Process | Where-Object {
  $_.Name -eq 'Weixin' -or $_.Name -eq 'weixin' -or
  $_.Name -eq 'WeChat' -or $_.Name -eq 'WeChatAppEx'
} | Select-Object -First 1
if (-not $proc) { Write-Output '{"status":"not_running"}'; exit 0 }
$handle = $proc.MainWindowHandle
$window = $null
if ($handle -ne [IntPtr]::Zero) { try { $window = [Windows.Automation.AutomationElement]::FromHandle($handle) } catch { } }
if (-not $window) {
  $root = [Windows.Automation.AutomationElement]::RootElement
  $winCond = New-Object Windows.Automation.OrCondition(
    (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ClassNameProperty, 'WeChatMainWndForPC')),
    (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty, '微信')))
  try { $candidates = $root.FindAll([Windows.Automation.TreeScope]::Children, $winCond) } catch { $candidates = @() }
  foreach ($c in $candidates) { try { if ($c.Current.ClassName -eq 'WeChatMainWndForPC' -or $c.Current.Name -match '微信') { $window = $c; break } } catch { } }
  if (-not $window) {
    try { $allChildren = $root.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition) } catch { $allChildren = @() }
    foreach ($c in $allChildren) { try { if ($c.Current.ClassName -eq 'WeChatMainWndForPC' -or $c.Current.Name -match '微信') { $window = $c; break } } catch { } }
  }
}
if (-not $window) { Write-Output '{"status":"window_not_found"}'; exit 0 }

# ── Force-restore from minimized (UIA tree needs Normal state) ──────
# BACKGROUND_ONLY gate: restoring window steals focus
$backgroundOnly = ($env:ARKTERM_WECHAT_BACKGROUND_ONLY -ne '0')
if (-not $backgroundOnly) {
  try {
    $wp = $window.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern)
    if ($wp -and $wp.Current.WindowVisualState -eq 'Minimized') {
      $wp.SetWindowVisualState([Windows.Automation.WindowVisualState]::Normal)
      Start-Sleep -Milliseconds 300
    }
  } catch { }
}

$title = ""; try { $title = $window.Current.Name } catch { }
$windowRect = $null; try { $windowRect = $window.Current.BoundingRectangle } catch { }
$activeContact = $null; $availableContacts = @(); $sidebarFound = $false; $sidebarItems = $null
$itemCond = New-Object Windows.Automation.OrCondition(
  (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::ListItem)),
  (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::TreeItem)))
foreach ($ct in @([Windows.Automation.ControlType]::List, [Windows.Automation.ControlType]::Tree, [Windows.Automation.ControlType]::DataGrid)) {
  if ($sidebarFound) { break }
  try { $ctCond = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, $ct); $containers = $window.FindAll([Windows.Automation.TreeScope]::Descendants, $ctCond) } catch { continue }
  foreach ($container in $containers) {
    try {
      $cr = $container.Current.BoundingRectangle
      if (-not $cr -or $cr.Width -le 0 -or $cr.Height -le 0) { continue }
      if ($cr.X -ge ($windowRect.X + $windowRect.Width * 0.38)) { continue }
      if ($cr.Height -le ($windowRect.Height * 0.30)) { continue }
      $items = $container.FindAll([Windows.Automation.TreeScope]::Children, $itemCond)
      if ($items.Count -lt 1) { continue }
      $sidebarFound = $true; $sidebarItems = @($items)
      foreach ($item in $items) {
        try {
          $n = $item.Current.Name; if (-not $n -or $n.Trim().Length -lt 1) { continue }
          $cn = $n.Trim()
          if ($cn -match '^(微信|WeChat|通讯录|发现|朋友圈|视频号|搜一搜|小程序|设置|看一看|搜狗输入法|表情|收藏|卡包|相册|直播|视频|文件传输助手|微信支付|公众号|服务号|订阅号)$') { continue }
          if ($availableContacts -notcontains $cn) { $availableContacts += $cn }
          try { $sel = $item.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern); if ($sel -and $sel.Current.IsSelected) { $activeContact = $cn } } catch { }
        } catch { }
      }
      break
    } catch { }
  }
}
$contactMatched = $false
if ($targetContact -and $targetContact.Length -gt 0 -and $sidebarItems) {
  $bestMatch = $null
  # Manual exact-name traversal — extract first line from multi-line Name
  # WeChat ListItem.Name format: Contact + newline + Preview + [3条] + time
  foreach ($item in $sidebarItems) {
    try {
      $actualName = ($item.Current.Name -split "\\r?\\n")[0].Trim()
      if ($actualName -eq $targetContact) { $bestMatch = $item; break }
    } catch { }
  }
  if ($bestMatch) {
    $contactMatched = $true
    try { $bestName = ($bestMatch.Current.Name -split "\\r?\\n")[0].Trim() } catch { $bestName = $targetContact }
    if ($activeContact -ne $bestName) {
      # ── Three-stage combo (SetFocus gated by BACKGROUND_ONLY) ─
      if (-not $backgroundOnly) { try { $bestMatch.SetFocus() } catch { } }
      try {
        $selP = $bestMatch.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)
        if ($selP) { $selP.Select() }
      } catch { }
      try {
        $legacyP = $bestMatch.GetCurrentPattern([Windows.Automation.AutomationPattern]::LookupById(10018))
        if ($legacyP) { $legacyP.DoDefaultAction() }
      } catch { }
      Start-Sleep -Milliseconds 700
      $activeContact = $bestName
    }
  }
}
$chatLeft = $windowRect.X + $windowRect.Width * 0.30
if ($sidebarItems) { try { $sr = 0; foreach ($item in $sidebarItems) { try { $ir = $item.Current.BoundingRectangle; if ($ir -and $ir.Right -gt $sr) { $sr = $ir.Right } } catch { } }; if ($sr -gt 0) { $chatLeft = $sr + 8 } } catch { } }
$chatPanel = $window
$paneCond = New-Object Windows.Automation.OrCondition(
  (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Pane)),
  (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Group)))
try { $panes = $window.FindAll([Windows.Automation.TreeScope]::Descendants, $paneCond) } catch { $panes = @() }
$bestScore = 0
foreach ($p in $panes) {
  try {
    $pr = $p.Current.BoundingRectangle; if (-not $pr -or $pr.Width -le 0 -or $pr.Height -le 0) { continue }
    if ($pr.X -lt $chatLeft - 20) { continue }
    $cItems = $p.FindAll([Windows.Automation.TreeScope]::Children, (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::ListItem)))
    $sc = $cItems.Count
    try { if ($p.FindFirst([Windows.Automation.TreeScope]::Descendants, (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Edit)))) { $sc += 50 } } catch { }
    if ($sc -gt $bestScore) { $bestScore = $sc; $chatPanel = $p }
  } catch { }
}
$midX = 0
try { $cpr = $chatPanel.Current.BoundingRectangle; if ($cpr -and $cpr.Width -gt 0) { $midX = $cpr.X + $cpr.Width / 2 } } catch { }
if ($midX -eq 0 -and $windowRect -and $windowRect.Width -gt 0) { $midX = $windowRect.X + $windowRect.Width / 2 }
$msgCond = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::ListItem)
try { $listItems = $chatPanel.FindAll([Windows.Automation.TreeScope]::Descendants, $msgCond) } catch { $listItems = @() }
$chromeWords = @('微信','WeChat','通讯录','发现','我','朋友圈','视频号','搜一搜','文件传输','订阅号','小程序','设置','看一看','搜狗输入法','表情','收藏','卡包','相册','摇一摇','附近','漂流瓶','购物','游戏','直播','视频')
$rawMessages = @(); $cSet = @{}; foreach ($c in $availableContacts) { $cSet[$c] = $true }
foreach ($item in $listItems) {
  try {
    $txt = $item.Current.Name; if (-not $txt -or $txt.Length -lt 1 -or $txt.Length -gt 5000) { continue }
    $rect = $item.Current.BoundingRectangle
    if ($rect -and $rect.Width -gt 0) { if ($rect.X -lt $chatLeft) { continue } }
    $t = $txt.Trim()
    if ($t -match '\\[\\d+条\\]|\\[\\d+\\+\\]') { continue }
    if ($t -match '^.+\\s+\\d{1,2}:\\d{2}\\s*$') { continue }
    if ($t -match '^\\d{1,2}:\\d{2}$|^昨天$|^星期|^\\d{4}/\\d{1,2}/\\d{1,2}$|^\\d{1,2}:\\d{2}\\s*(AM|PM)?$|^上午|^下午|^刚刚$') { continue }
    if ($cSet.ContainsKey($t)) { continue }
    $isC = $false; foreach ($cw in $chromeWords) { if ($t -eq $cw) { $isC = $true; break } }; if ($isC) { continue }
    $isR = $false
    if ($rect -and $midX -gt 0 -and $rect.Width -gt 0) { $isR = (($rect.X + $rect.Width / 2) -gt $midX) }
    $rawMessages += @{ text = $txt; isMe = $isR }
  } catch { }
}
if ($rawMessages.Count -le 1) {
  $tCond = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Text)
  try { $tEls = $chatPanel.FindAll([Windows.Automation.TreeScope]::Descendants, $tCond) } catch { $tEls = @() }
  foreach ($el in $tEls) {
    try {
      $txt = $el.Current.Name; if (-not $txt -or $txt.Length -lt 1 -or $txt.Length -gt 5000) { continue }
      $t = $txt.Trim(); $rect = $el.Current.BoundingRectangle
      if ($rect -and $rect.Width -gt 0) { if ($rect.X -lt $chatLeft) { continue } }
      if ($cSet.ContainsKey($t)) { continue }
      if ($t -match '\\[\\d+条\\]|\\[\\d+\\+\\]') { continue }
      if ($t -match '^.+\\s+\\d{1,2}:\\d{2}\\s*$') { continue }
      $isR = $false; if ($rect -and $midX -gt 0 -and $rect.Width -gt 0) { $isR = (($rect.X + $rect.Width / 2) -gt $midX) }
      $rawMessages += @{ text = $txt; isMe = $isR }
    } catch { }
  }
}
$editCond = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Edit)
try { $editBox = $chatPanel.FindFirst([Windows.Automation.TreeScope]::Descendants, $editCond) } catch { $editBox = $null }
$chatOpen = ($editBox -ne $null)
$result = @{
  status = "ok"; title = $title
  activeContact = if ($activeContact) { $activeContact } else { $null }
  availableContacts = @($availableContacts | Select-Object -Unique)
  contactMatched = $contactMatched; chatOpen = $chatOpen
  messageCount = $rawMessages.Count; messages = @($rawMessages)
}
Write-Output (ConvertTo-Json $result -Compress -Depth 5)
`.trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// One-shot PowerShell script — send message via UIA
// ═══════════════════════════════════════════════════════════════════════════

function buildSendMessageScript(contactName, text) {
  const escapedContact = (contactName || '').replace(/'/g, "''");
  const escapedText = (text || '').replace(/'/g, "''").replace(/"/g, '\\"');
  return `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$PSDefaultParameterValues['*:Encoding'] = 'utf8'
$ErrorActionPreference = 'SilentlyContinue'

Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue

$targetContact = '${escapedContact}'
$messageText = '${escapedText}'

# ═══ Win32 — minimal: only PostMessage for background Enter ═══════════════
$bgWin32 = @"
using System;
using System.Runtime.InteropServices;
public class BgSendWin32 {
    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);
    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);
}
"@
try { Add-Type -TypeDefinition $bgWin32 -ErrorAction SilentlyContinue } catch { }

$WM_KEYDOWN = 0x0100
$WM_KEYUP   = 0x0101
$VK_RETURN  = 0x0D

# ═══ 1. Get WeChat process ══════════════════════════════════════════════════
$proc = $null
try {
  $proc = Get-Process | Where-Object {
    $_.Name -eq 'Weixin' -or $_.Name -eq 'weixin' -or
    $_.Name -eq 'WeChat' -or $_.Name -eq 'WeChatAppEx'
  } | Select-Object -First 1
} catch { }

if (-not $proc) {
  Write-Output '{"status":"not_running"}'
  exit 0
}

# ═══ 2. Locate WeChat window ═══════════════════════════════════════════════
$window = $null
$hWnd = [IntPtr]::Zero
try {
  $hWnd = $proc.MainWindowHandle
  if ($hWnd -ne [IntPtr]::Zero) {
    $window = [Windows.Automation.AutomationElement]::FromHandle($hWnd)
  }
} catch { }

if (-not $window) {
  try {
    $root = [Windows.Automation.AutomationElement]::RootElement
    $winCond = New-Object Windows.Automation.OrCondition(
      (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ClassNameProperty, 'WeChatMainWndForPC')),
      (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::NameProperty, '微信')))
    $candidates = $root.FindAll([Windows.Automation.TreeScope]::Children, $winCond)
    foreach ($c in $candidates) {
      try { if ($c.Current.ClassName -eq 'WeChatMainWndForPC' -or $c.Current.Name -match '微信') { $window = $c; try { $hWnd = [IntPtr]($c.Current.NativeWindowHandle) } catch { }; break } } catch { }
    }
  } catch { }
  if (-not $window) {
    try {
      $allChildren = $root.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)
      foreach ($c in $allChildren) {
        try { if ($c.Current.ClassName -eq 'WeChatMainWndForPC' -or $c.Current.Name -match '微信') { $window = $c; try { $hWnd = [IntPtr]($c.Current.NativeWindowHandle) } catch { }; break } } catch { }
      }
    } catch { }
  }
}

if (-not $window) {
  Write-Output '{"status":"window_not_found"}'
  exit 0
}

# ═══ 3. Gentle restore — un-minimize WITHOUT stealing foreground ═════════
try {
  $wp = $window.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern)
  if ($wp -and $wp.Current.WindowVisualState -eq 'Minimized') {
    $wp.SetWindowVisualState([Windows.Automation.WindowVisualState]::Normal)
    Start-Sleep -Milliseconds 500
  }
} catch { }

# Ensure window is visible (SW_SHOWNOACTIVATE=4: show but don't activate)
if ($hWnd -ne [IntPtr]::Zero) {
  try { [BgSendWin32]::ShowWindowAsync($hWnd, 4) | Out-Null } catch { }
  Start-Sleep -Milliseconds 200
}

$windowRect = $null
try { $windowRect = $window.Current.BoundingRectangle } catch { }

# ═══ 4. Locate target contact in left sidebar (UIA-only, no mouse) ═══════
$targetItem = $null
$sidebarFound = $false

try {
  $itemCond = New-Object Windows.Automation.OrCondition(
    (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::ListItem)),
    (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::TreeItem))
  )

  $containerTypes = @([Windows.Automation.ControlType]::List, [Windows.Automation.ControlType]::Tree, [Windows.Automation.ControlType]::DataGrid)

  foreach ($ct in $containerTypes) {
    if ($sidebarFound) { break }
    try {
      $ctCond = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, $ct)
      $containers = $window.FindAll([Windows.Automation.TreeScope]::Descendants, $ctCond)
    } catch { continue }

    foreach ($container in $containers) {
      try {
        $cr = $container.Current.BoundingRectangle
        if (-not $cr -or $cr.Width -le 0 -or $cr.Height -le 0) { continue }
        if (-not $windowRect) { continue }
        $inLeft = ($cr.X -lt ($windowRect.X + $windowRect.Width * 0.38))
        $tallEnough = ($cr.Height -gt ($windowRect.Height * 0.30))
        if (-not $inLeft -or -not $tallEnough) { continue }

        $items = $container.FindAll([Windows.Automation.TreeScope]::Children, $itemCond)
        if ($items.Count -lt 1) { continue }
        $sidebarFound = $true

        $scanLimit = [Math]::Min(20, $items.Count)
        for ($si = 0; $si -lt $scanLimit; $si++) {
          try {
            $item = $items[$si]
            $n = $item.Current.Name
            if (-not $n -or $n.Trim().Length -lt 1) { continue }
            $actualName = ($n -split "\\r?\\n")[0].Trim()
            if ($actualName.Length -gt 0 -and $actualName -eq $targetContact) {
              $targetItem = $item; break
            }
          } catch { }
        }
        break
      } catch { }
    }
  }
} catch { }

if (-not $targetItem) {
  Write-Output '{"status":"contact_not_found","error":"在左侧列表中未找到联系人"}'
  exit 0
}

# ═══ 5. Select contact — robust 3-stage combo (same as radar's switchAndReceive) ═
# Stage 0: Check if already the active contact (fast-path)
$alreadySelected = $false
try {
  $selPat = $targetItem.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)
  if ($selPat -and $selPat.Current.IsSelected) {
    $alreadySelected = $true
  }
} catch { }

if (-not $alreadySelected) {
  # Contact is NOT the active one — need to switch
  $bkgOnly = ($env:ARKTERM_WECHAT_BACKGROUND_ONLY -ne '0')

  if ($bkgOnly) {
    # ═══ BACKGROUND-ONLY: foreground activation + FULL fresh UIA scan ════
    # SetForegroundWindow causes Chromium WebView2 to rebuild its ENTIRE
    # UIA tree. EVERY AutomationElement reference — $window, $container,
    # $targetItem — is STALE after activation. Re-acquire from scratch.
    try { $savedForegroundHwnd = [BgSendWin32]::GetForegroundWindow() } catch { }
    try { [BgSendWin32]::SetForegroundWindow($hWnd) | Out-Null } catch { }
    Start-Sleep -Milliseconds 500

    # ── Refresh window from stable HWND ──────────────────────────────────
    try { $window = [Windows.Automation.AutomationElement]::FromHandle($hWnd) } catch { }
    try { $windowRect = $window.Current.BoundingRectangle } catch { }

    # ── Full sidebar re-scan: container → items (all fresh references) ───
    $freshItem = $null
    $freshContainer = $null
    $debugInfo = ''
    try {
      foreach ($ct in @([Windows.Automation.ControlType]::List, [Windows.Automation.ControlType]::Tree, [Windows.Automation.ControlType]::DataGrid)) {
        if ($freshItem) { break }
        try {
          $ctCond2 = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, $ct)
          $newContainers = $window.FindAll([Windows.Automation.TreeScope]::Descendants, $ctCond2)
        } catch { continue }

        foreach ($nc in $newContainers) {
          if ($freshItem) { break }
          try {
            $ncr = $nc.Current.BoundingRectangle
            if (-not $ncr -or $ncr.Width -le 0 -or $ncr.Height -le 0) { continue }
            if (-not $windowRect) { continue }
            $inLeft = ($ncr.X -lt ($windowRect.X + $windowRect.Width * 0.38))
            $tallEnough = ($ncr.Height -gt ($windowRect.Height * 0.30))
            if (-not $inLeft -or -not $tallEnough) { continue }

            $nItems = $nc.FindAll([Windows.Automation.TreeScope]::Children, $itemCond)
            if ($nItems.Count -lt 1) { continue }
            $freshContainer = $nc

            $nTop = [Math]::Min(30, $nItems.Count)
            for ($ni = 0; $ni -lt $nTop; $ni++) {
              try {
                $nn = ($nItems[$ni].Current.Name -split "\r?\n")[0].Trim()
                if ($nn -eq $targetContact) { $freshItem = $nItems[$ni]; break }
              } catch { }
            }
            if ($freshItem) { break }
          } catch { }
        }
      }
    } catch { }

    if (-not $freshItem) {
      # Diagnostic: what contacts are in the sidebar?
      try {
        if ($freshContainer) {
          $allNames = @()
          try {
            $fcItems = $freshContainer.FindAll([Windows.Automation.TreeScope]::Children, $itemCond)
            $fcTop = [Math]::Min(15, $fcItems.Count)
            for ($fci = 0; $fci -lt $fcTop; $fci++) {
              try { $allNames += ($fcItems[$fci].Current.Name -split "\r?\n")[0].Trim() } catch { }
            }
          } catch { }
          $debugInfo = "; sidebar(" + $fcItems.Count + "): [" + ($allNames -join ', ') + "]"
        } else {
          $debugInfo = "; no sidebar container after SetForegroundWindow"
        }
      } catch { $debugInfo = "; debug scan failed" }
    }

    if ($freshItem) {
      # ── Real mouse click at contact position ──────────────────────────
      # UIA Select/Invoke/DoDefaultAction are UNRELIABLE with Chrome WebView2.
      # Instead: use UIA only to READ the contact's screen position, then
      # click with Win32 mouse_event — OS-level clicks that WebView2 can't ignore.
      try {
        $fr = $freshItem.Current.BoundingRectangle
        if ($fr -and $fr.Width -gt 0 -and $fr.Height -gt 0) {
          $clickX = $fr.X + [int]($fr.Width / 2)
          $clickY = $fr.Y + [int]($fr.Height / 2)

          # Save cursor, click, restore
          $savedCX = 0; $savedCY = 0
          try {
            $sp = [System.Windows.Forms.Cursor]::Position
            $savedCX = $sp.X; $savedCY = $sp.Y
          } catch { }

          [BgSendWin32]::SetCursorPos($clickX, $clickY) | Out-Null
          Start-Sleep -Milliseconds 40
          [BgSendWin32]::mouse_event(0x0002, 0, 0, 0, 0) | Out-Null  # LEFTDOWN
          Start-Sleep -Milliseconds 30
          [BgSendWin32]::mouse_event(0x0004, 0, 0, 0, 0) | Out-Null  # LEFTUP
          Start-Sleep -Milliseconds 60

          if ($savedCX -gt 0 -or $savedCY -gt 0) {
            [BgSendWin32]::SetCursorPos($savedCX, $savedCY) | Out-Null
          }

          $debugInfo = "; clicked at " + $clickX + "," + $clickY
        }
      } catch { $debugInfo = "; click exception: " + $_.Exception.Message }
      Start-Sleep -Milliseconds 700
    }
    # Keep WeChat foreground — B3 will restore $savedForegroundHwnd
  }
  else {
    # ═══ NORMAL MODE: SetFocus + Select + Invoke + DoDefaultAction ══════
    try { $targetItem.SetFocus() } catch { }
    try {
      $selP = $targetItem.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)
      if ($selP) { $selP.Select() }
    } catch { }
    try {
      $invP = $targetItem.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
      if ($invP) { $invP.Invoke() }
    } catch { }
    try {
      $legacyP = $targetItem.GetCurrentPattern([Windows.Automation.AutomationPattern]::LookupById(10018))
      if ($legacyP) { $legacyP.DoDefaultAction() }
    } catch { }
    Start-Sleep -Milliseconds 700
  }

  # ── Verification: FULL fresh scan for active contact ──────────────────
  # After contact switch, the UIA tree may have changed AGAIN. Re-scan
  # everything from $window — never reuse stale $container reference.
  $verifiedActive = ''
  try {
    foreach ($vct in @([Windows.Automation.ControlType]::List, [Windows.Automation.ControlType]::Tree, [Windows.Automation.ControlType]::DataGrid)) {
      if ($verifiedActive.Length -gt 0) { break }
      try {
        $vctCond = New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, $vct)
        $vContainers = $window.FindAll([Windows.Automation.TreeScope]::Descendants, $vctCond)
      } catch { continue }

      foreach ($vc in $vContainers) {
        if ($verifiedActive.Length -gt 0) { break }
        try {
          $vcr = $vc.Current.BoundingRectangle
          if (-not $vcr -or $vcr.Width -le 0 -or $vcr.Height -le 0) { continue }
          if (-not $windowRect) { try { $windowRect = $window.Current.BoundingRectangle } catch { } }
          if (-not $windowRect) { continue }
          if ($vcr.X -ge ($windowRect.X + $windowRect.Width * 0.38)) { continue }
          if ($vcr.Height -le ($windowRect.Height * 0.30)) { continue }

          $vItems = $vc.FindAll([Windows.Automation.TreeScope]::Children, $itemCond)
          $vTop = [Math]::Min(30, $vItems.Count)
          for ($vi = 0; $vi -lt $vTop; $vi++) {
            try {
              $viItem = $vItems[$vi]
              $viName = ($viItem.Current.Name -split "\r?\n")[0].Trim()
              $viSel = $viItem.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)
              if ($viSel -and $viSel.Current.IsSelected -and $viName.Length -gt 0) {
                $verifiedActive = $viName
                break
              }
            } catch { }
          }
          break
        } catch { }
      }
    }
  } catch { }

  if ($verifiedActive.Length -gt 0 -and $verifiedActive -ne $targetContact) {
    $method = if ($bkgOnly) { 'sidebar_foreground' } else { 'sidebar_select' }
    Write-Output ('{"status":"switch_failed","error":"active is ' + $verifiedActive + ', not ' + $targetContact + ' (method: ' + $method + ')' + $debugInfo + '"}')
    exit 0
  }

  if ($verifiedActive.Length -eq 0) {
    Write-Output '{"status":"switch_uncertain","warning":"no contact reports IsSelected; proceeding anyway"}'
  }
}

# ═══ 6. Find Edit control ══════════════════════════════════════════════════
$editCond = New-Object Windows.Automation.PropertyCondition(
  [Windows.Automation.AutomationElement]::ControlTypeProperty,
  [Windows.Automation.ControlType]::Edit
)
$editBoxes = $window.FindAll([Windows.Automation.TreeScope]::Descendants, $editCond)
$editBox = $null

foreach ($eb in $editBoxes) {
  try {
    $r = $eb.Current.BoundingRectangle
    if ($r -and $r.Width -gt 100 -and $r.Height -gt 20 -and $r.Y -gt ($windowRect.Height * 0.55)) {
      $editBox = $eb
      break
    }
  } catch { }
}

if (-not $editBox) {
  if ($editBoxes.Count -gt 0) {
    $editBox = $editBoxes[$editBoxes.Count - 1]
  }
}

if (-not $editBox) {
  Write-Output '{"status":"no_input_found"}'
  exit 0
}

# ═══ 7. Inject text + background-send ══════════════════════════════════════
try {
  # ── Background-only is DEFAULT: no SetForegroundWindow/SendKeys fallback.
  # Only allow foreground when user explicitly set ARKTERM_WECHAT_BACKGROUND_ONLY=0.
  $allowForegroundFallback = ($env:ARKTERM_WECHAT_BACKGROUND_ONLY -eq '0')

  # Pre-send: give the Edit box UIA focus. This primes the element and may
  # help the UIA provider expose the Send button / process PostMessage.
  try { $editBox.SetFocus() } catch { }
  Start-Sleep -Milliseconds 100

  # Step A: Set text via ValuePattern (no foreground needed)
  $valuePattern = $null
  try { $valuePattern = $editBox.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern) } catch { }
  if ($valuePattern) {
    $valuePattern.SetValue($messageText)
  } elseif ($allowForegroundFallback) {
    # Fallback: focus + SendKeys (requires foreground) — gated by BACKGROUND_ONLY
    $currentHwnd = [IntPtr]::Zero
    try { $currentHwnd = [BgSendWin32]::GetForegroundWindow() } catch { }
    try { [BgSendWin32]::SetForegroundWindow($hWnd) | Out-Null } catch { }
    Start-Sleep -Milliseconds 150
    try { $editBox.SetFocus() } catch { }
    Start-Sleep -Milliseconds 100
    [System.Windows.Forms.SendKeys]::SendWait(($messageText -replace '[+^%~(){}]', '{$0}'))
    if ($currentHwnd -ne [IntPtr]::Zero) {
      try { [BgSendWin32]::SetForegroundWindow($currentHwnd) | Out-Null } catch { }
    }
  }

  Start-Sleep -Milliseconds 200

  function Get-InputValue {
    try {
      $vp = $editBox.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
      if ($vp) { return [string]$vp.Current.Value }
    } catch { }
    return $null
  }

  function Test-InputCleared {
    $v = Get-InputValue
    if ($null -eq $v) { return $false }
    return ([string]$v).Trim().Length -eq 0
  }

  # Step B: Trigger send — try background methods first, verify by input clearing
  $sent = $false
  $sendMethod = ''
  $editRect = $null
  try { $editRect = $editBox.Current.BoundingRectangle } catch { }

  # B1: Find Send button via UIA and invoke it (pure background)
  # Strategy: first search by Name, then by geometric position relative to Edit box.
  try {
    $btnCond = New-Object Windows.Automation.OrCondition(
      (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button)),
      (New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::SplitButton))
    )
    $buttons = $window.FindAll([Windows.Automation.TreeScope]::Descendants, $btnCond)
    $sendBtn = $null

    foreach ($btn in $buttons) {
      try {
        $bn = $btn.Current.Name
        $br = $btn.Current.BoundingRectangle
        # Exact name match
        if ($bn -match '^(发送|Send|send)$') {
          $sendBtn = $btn; break
        }
        # Geometric candidate: small button near the Edit box's right edge
        if ($editRect -and $br -and $br.Width -gt 30 -and $br.Width -lt 120 -and $br.Height -gt 18 -and $br.Height -lt 50) {
          if ($br.Y -ge ($editRect.Y - 15) -and $br.Y -le ($editRect.Y + $editRect.Height + 15) -and
              $br.X -gt ($editRect.X + $editRect.Width * 0.60) -and
              $br.X -lt ($editRect.X + $editRect.Width + 280)) {
            if ($bn -notmatch '表情|文件|截图|语音|更多|Emoji|File|Sticker|Voice') {
              if (-not $sendBtn) { $sendBtn = $btn }
            }
          }
        }
      } catch { }
    }

    # Fallback: if no candidate found, try the last button near the bottom-right
    if (-not $sendBtn -and $windowRect) {
      $bestDist = 99999
      $targetX = $windowRect.X + $windowRect.Width * 0.92
      $targetY = $windowRect.Y + $windowRect.Height * 0.82
      foreach ($btn in $buttons) {
        try {
          $br = $btn.Current.BoundingRectangle
          if (-not $br -or $br.Width -lt 25 -or $br.Height -lt 15) { continue }
          $dist = [Math]::Sqrt((($br.X - $targetX)*($br.X - $targetX)) + (($br.Y - $targetY)*($br.Y - $targetY)))
          if ($dist -lt $bestDist) { $bestDist = $dist; $sendBtn = $btn }
        } catch { }
      }
    }

    if ($sendBtn) {
      $invP = $sendBtn.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
      if ($invP) {
        $invP.Invoke()
        Start-Sleep -Milliseconds 700
        if (Test-InputCleared) {
          $sent = $true
          $sendMethod = 'uia_button'
        }
      }
    }
  } catch { }

  # B2: PostMessage VK_RETURN — try Edit HWND first, then main WeChat HWND
  # Chromium WebView2: the Edit control's NativeWindowHandle may belong to the
  # Chromium host, which ignores WM_KEYDOWN. Fall back to the main WeChat window.
  if (-not $sent) {
    try {
      $targetHwnds = @()
      $editHwnd = [IntPtr]::Zero
      try { $editHwnd = [IntPtr]($editBox.Current.NativeWindowHandle) } catch { }
      if ($editHwnd -ne [IntPtr]::Zero) { $targetHwnds += $editHwnd }
      if ($hWnd -ne [IntPtr]::Zero -and $hWnd -ne $editHwnd) { $targetHwnds += $hWnd }

      $KEYDOWN_LPARAM = [IntPtr][UInt32]0x001C0001
      $KEYUP_LPARAM   = [IntPtr][UInt32]0xC01C0001

      foreach ($targetHwnd in $targetHwnds) {
        [BgSendWin32]::PostMessage($targetHwnd, $WM_KEYDOWN, [IntPtr]$VK_RETURN, $KEYDOWN_LPARAM) | Out-Null
        Start-Sleep -Milliseconds 30
        [BgSendWin32]::PostMessage($targetHwnd, $WM_KEYUP, [IntPtr]$VK_RETURN, $KEYUP_LPARAM) | Out-Null
        Start-Sleep -Milliseconds 700
        if (Test-InputCleared) {
          $sent = $true
          $sendMethod = 'post_enter'
          break
        }
      }
    } catch { }
  }

  # B3: Last resort — brief foreground + SendKeys Enter, then restore.
  # In BACKGROUND_ONLY mode this is the ONLY reliable way to trigger send
  # (UIA button + PostMessage are unreliable with WebView2 in background).
  # Uses $savedForegroundHwnd if set by BKG_ONLY contact switch (which
  # already activated WeChat); otherwise saves+restores current foreground.
  if (-not $sent) {
      $restoreHwnd = if ($savedForegroundHwnd -and $savedForegroundHwnd -ne [IntPtr]::Zero) {
        $savedForegroundHwnd
      } else {
        try { [BgSendWin32]::GetForegroundWindow() } catch { [IntPtr]::Zero }
      }
      # Only activate WeChat if it's not already foreground (attempt 4 may have done it)
      $wechatActive = $false
      try { $curFg = [BgSendWin32]::GetForegroundWindow(); if ($curFg -eq $hWnd) { $wechatActive = $true } } catch { }
      if (-not $wechatActive) {
        try { [BgSendWin32]::SetForegroundWindow($hWnd) | Out-Null } catch { }
        Start-Sleep -Milliseconds 80
      }
      try { $editBox.SetFocus() } catch { }
      Start-Sleep -Milliseconds 50
      [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
      Start-Sleep -Milliseconds 500
      if (Test-InputCleared) {
        $sent = $true
        $sendMethod = 'foreground_enter'
      }
      if (-not $sent) {
        [System.Windows.Forms.SendKeys]::SendWait('^{ENTER}')
        Start-Sleep -Milliseconds 500
        if (Test-InputCleared) {
          $sent = $true
          $sendMethod = 'foreground_ctrl_enter'
        }
      }
      if ($restoreHwnd -ne [IntPtr]::Zero -and $restoreHwnd -ne $hWnd) {
        try { [BgSendWin32]::SetForegroundWindow($restoreHwnd) | Out-Null } catch { }
      }
  }

  if ($sent) {
    Write-Output ('{"status":"sent","method":"' + $sendMethod + '"}')
  } else {
    Write-Output '{"status":"send_failed","error":"message_still_in_input"}'
  }
} catch {
  $errMsg = ""
  try { $errMsg = $_.Exception.Message -replace "\n", " " } catch { $errMsg = "unknown" }
  Write-Output "{""status"":""send_failed"",""error"":""$errMsg""}"
}
`.trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// PowerShell helpers
// ═══════════════════════════════════════════════════════════════════════════

function runPowerShell(script, timeoutMs = 12000) {
  return new Promise((resolve) => {
    const child = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-Command', script,
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (d) => { stdoutChunks.push(d); });
    child.stderr.on('data', (d) => { stderrChunks.push(d); });

    const timer = setTimeout(() => {
      child.kill();
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      resolve({ ok: false, error: 'timeout', stderr });
    }, timeoutMs);

    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8').replace(/^﻿/, '');
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      if (code === 0) {
        const raw = stdout.trim();
        try {
          resolve({ ok: true, data: JSON.parse(raw || '{}'), raw: stdout, stderr });
        } catch {
          const jsonLine = raw.split(/\r?\n/).reverse().find((line) => {
            const t = line.trim();
            return t.startsWith('{') && t.endsWith('}');
          });
          if (jsonLine) {
            try {
              resolve({ ok: true, data: JSON.parse(jsonLine), raw: stdout, stderr });
              return;
            } catch { }
          }
          resolve({ ok: false, error: 'json_parse', raw: stdout.slice(0, 500), stderr });
        }
      } else {
        resolve({ ok: false, error: `exit_code_${code}`, stderr: stderr.slice(0, 500) });
      }
    });

    child.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: err.message }); });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// One-shot WeChat history fetch (for contact switching)
// ═══════════════════════════════════════════════════════════════════════════

async function fetchLocalWechatHistory(targetContact) {
  const result = await runPowerShell(buildUiaScript(targetContact || ''), 15000);
  if (!result.ok || !result.data) {
    return { status: 'scan_failed', contact: null, activeContact: null,
      availableContacts: [], contactMatched: false,
      messages: [], conversation: [], chatOpen: false, latestMessage: '', rawMessages: [] };
  }
  const data = result.data;
  if (data.status === 'not_running' || data.status === 'minimized' || data.status === 'window_not_found') {
    return { status: data.status, contact: null, activeContact: null,
      availableContacts: [], contactMatched: false,
      messages: [], conversation: [], chatOpen: false, latestMessage: '', rawMessages: [] };
  }
  if (data.status !== 'ok') {
    return { status: 'scan_failed', contact: null, activeContact: null,
      availableContacts: [], contactMatched: false,
      messages: [], conversation: [], chatOpen: false, latestMessage: '', rawMessages: [] };
  }
  const rawMessages = data.messages || [];
  const conversation = [];
  for (const m of rawMessages) {
    const text = (m.text || '').trim();
    if (!text || text.length < 1) continue;
    conversation.push({ role: m.isMe ? 'me' : 'them', text });
  }
  const theirMessages = conversation.filter((m) => m.role === 'them').map((m) => m.text);
  return {
    status: rawMessages.length === 0 ? 'no_messages' : 'ok',
    contact: data.activeContact || data.title || '微信',
    activeContact: data.activeContact || null,
    availableContacts: data.availableContacts || [],
    contactMatched: data.contactMatched || false,
    messages: rawMessages.map((m) => m.text),
    conversation, chatOpen: data.chatOpen || false,
    latestMessage: theirMessages[theirMessages.length - 1] || '',
    rawMessages,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Send WeChat message — one-shot PowerShell injection
// ═══════════════════════════════════════════════════════════════════════════

async function sendWechatMessage(contactName, text) {
  if (!text || text.trim().length === 0) {
    return { status: 'error', error: '消息内容为空' };
  }
  if (isIgnoredWechatContact(contactName)) {
    return { status: 'error', error: `不会向系统/服务联系人 "${contactName}" 自动发送` };
  }
  const result = await runPowerShell(buildSendMessageScript(contactName, text), 12000);
  if (!result.ok) {
    const detail = result.raw ? `: ${result.raw.replace(/\s+/g, ' ').slice(0, 160)}` : '';
    return { status: 'error', error: `${result.error || 'PowerShell 执行失败'}${detail}` };
  }
  const data = result.data;
  if (data.status === 'not_running') {
    return { status: 'error', error: '微信未运行' };
  }
  if (data.status === 'window_not_found') {
    return { status: 'error', error: '无法定位微信窗口' };
  }
  if (data.status === 'contact_not_found') {
    return { status: 'error', error: `在微信左侧列表中未找到联系人 "${contactName}"，请确认名称完全匹配` };
  }
  if (data.status === 'switch_failed') {
    // Hard error — the PS script verified that a DIFFERENT contact is selected.
    // Sending would go to the wrong person, so we MUST abort.
    return { status: 'error', error: `联系人切换失败: ${data.error || '请手动点击 "' + contactName + '" 后再试'}` };
  }
  if (data.status === 'switch_uncertain') {
    // Soft warning — no contact reports IsSelected (Chromium UIA cache bug),
    // but the 3-stage selection combo ran without throwing. The PS script
    // continued to Edit-box injection. Accept the result.
    console.warn(chalk.yellow(`  [WeChat] ⚠ 联系人选择无法验证 (UIA缓存问题), 已尝试发送`));
    if (!_sentHistory.has(contactName)) _sentHistory.set(contactName, []);
    _sentHistory.get(contactName).push(text.trim());
    return { status: 'ok', sent: true, method: data.method || 'uncertain', warning: data.warning || '' };
  }
  if (data.status === 'no_input_found') {
    return { status: 'error', error: '未找到微信输入框，请确保聊天窗口已打开' };
  }
  if (data.status === 'send_failed') {
    return { status: 'error', error: `发送失败: ${data.error || '未知错误'}` };
  }
  if (data.status === 'sent') {
    if (!_sentHistory.has(contactName)) _sentHistory.set(contactName, []);
    _sentHistory.get(contactName).push(text.trim());
    return { status: 'ok', sent: true, method: data.method || '' };
  }
  return { status: 'error', error: `未知状态: ${data.status || 'null'}` };
}

// ═══════════════════════════════════════════════════════════════════════════
// Dynamic Few-shot prompt builder
// ═══════════════════════════════════════════════════════════════════════════

function buildFewShotPrompt(conversation) {
  if (!conversation || conversation.length === 0) return '';
  const recent = conversation.slice(-10);
  const lines = recent.map((turn) => {
    const label = turn.role === 'me' ? '[用户]' : '[对方]';
    return `${label}: ${turn.text}`;
  });
  return `
=== 当前窗口真实对话记录（最近${recent.length}条） ===
${lines.join('\n')}
=== 对话记录结束 ===

请严格模仿以上【用户】本人的真实语气、用词习惯和回复长度，继续回复对方最新发来的消息。`;
}

// ═══════════════════════════════════════════════════════════════════════════
// WeChatMonitor — persistent PowerShell process + auto-respawn
// ═══════════════════════════════════════════════════════════════════════════

class WeChatMonitor {
  /**
   * @param {object}   config
   * @param {object}   config.client          — OpenAI client instance
   * @param {string}   config.modelId         — model ID for reply generation
   * @param {function} config.onMessage       — (friendName, message, reply) => void
   * @param {function} config.onNewMessage    — (contact, text) => void — fires IMMEDIATELY
   * @param {function} config.onStatus        — (statusText) => void
   * @param {number}   [config.interval=15000] — ms between polls (fallback mode)
   */
  constructor(config) {
    this._client = config.client;
    this._modelId = config.modelId;
    this._onMessage = config.onMessage || (() => {});
    this._onNewMessage = config.onNewMessage || (() => {});
    this._onStatus = config.onStatus || (() => {});
    this._interval = config.interval || 15000;

    this._child = null;
    this._rl = null;
    this._respawnDelay = 3000;
    this._respawnTimer = null;
    this._running = false;

    this._targetContact = '';
    this._activeMode = false;
    this._fastPollUntil = 0;

    this._resetContacts = new Set();

    this._lastActiveContact = '';
    this._lastAvailableContacts = [];
    this._statusShown = { not_running: false, window_not_found: false, connected: false };
    this._initReceived = false;
  }

  setModelId(modelId) { this._modelId = modelId; }
  setClient(client) { this._client = client; }

  // ── Public API ────────────────────────────────────────────────────────

  start() {
    if (this._running) return;
    this._running = true;
    restoreWeChatWindow();
    this._onStatus('[WeChat] 正在启动持久监听进程...');
    this._spawnPersistent();
  }

  stop() {
    this._running = false;
    this._killChild();
    if (this._respawnTimer) { clearTimeout(this._respawnTimer); this._respawnTimer = null; }
  }

  async switchAndReceive(contactName) {
    if (!contactName) {
      return { status: 'error', error: '请指定联系人名称' };
    }

    this._targetContact = contactName;
    this._activeMode = true;
    this._fastPollUntil = Date.now() + 120000;

    this._resetContacts.add(contactName);

    this._killChild();

    const history = await fetchLocalWechatHistory(contactName);

    this._lastActiveContact = history.activeContact || '';

    if (this._running) {
      this._initReceived = false;
      this._spawnPersistent();
    }

    return {
      status: history.status,
      contact: history.contact,
      activeContact: history.activeContact,
      contactMatched: history.contactMatched,
      availableContacts: history.availableContacts,
      conversation: history.conversation,
      messageCount: history.messages.length,
      chatOpen: history.chatOpen,
    };
  }

  getAvailableContacts() {
    return this._lastAvailableContacts || [];
  }

  // ── Persistent process management ─────────────────────────────────────

  _spawnPersistent() {
    if (!this._running) return;

    this._killChild();

    // ── Verify radar script exists ──────────────────────────────────────
    if (!fs.existsSync(_radarScriptPath)) {
      this._onStatus(chalk.red(`[WeChat] 雷达脚本不存在: ${_radarScriptPath}`));
      this._scheduleRespawn();
      return;
    }

    // ── Spawn via -File (NO inline -Command) ────────────────────────────
    const targetArg = this._targetContact || '';
    let child;
    try {
      child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', _radarScriptPath,
        '-TargetContact', targetArg,
        '-MaxContacts', '30',
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      this._onStatus(chalk.red(`[WeChat] 无法启动 PowerShell: ${err.message}`));
      this._scheduleRespawn();
      return;
    }

    this._child = child;
    _trackChild(child);

    // ── stdout: native readline for robust line-by-line JSON parsing ────
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    this._rl = rl;

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const msg = JSON.parse(trimmed.replace(/^﻿/, ''));
        this._handlePersistentMsg(msg);
      } catch (e) {
        this._onStatus(chalk.yellow(`[WeChat] 跳过损坏JSON: ${trimmed.slice(0, 200)}`));
      }
    });

    // ── stderr: FORCE-PRINT every PowerShell error ──────────────────────
    child.stderr.on('data', (d) => {
      const text = d.toString('utf-8').trim();
      if (text) {
        this._onStatus(chalk.red(`[WeChat/PS] ${text.slice(0, 300)}`));
      }
    });

    // ── exit / error → respawn ──────────────────────────────────────────
    child.on('close', (code) => {
      this._child = null;
      _untrackChild();
      if (this._running) {
        const reason = (code !== 0 && code !== null)
          ? chalk.red(`异常退出 code=${code}`)
          : chalk.dim(`正常退出 code=${code ?? 'null'}`);
        this._onStatus(`[WeChat] PowerShell ${reason} — ${this._respawnDelay / 1000}s 后重启`);
        this._scheduleRespawn();
      }
    });

    child.on('error', (err) => {
      this._child = null;
      _untrackChild();
      if (this._running) {
        this._onStatus(chalk.red(`[WeChat] PowerShell 进程错误: ${err.message}`));
        this._scheduleRespawn();
      }
    });
  }

  _killChild() {
    // ── Safety: restore WeChat from legacy ghost mode (if a previous version set WS_EX_LAYERED) ──
    restoreWeChatWindow();

    if (this._rl) {
      try { this._rl.close(); } catch { }
      this._rl = null;
    }
    if (this._child) {
      const pid = this._child.pid;
      try { this._child.kill('SIGTERM'); } catch { }
      if (pid) {
        const cp = require('child_process');
        setTimeout(() => {
          try { cp.execSync(`taskkill /F /PID ${pid} /T 2>nul`, { windowsHide: true }); } catch { }
        }, 500);
      }
      this._child = null;
      _untrackChild();
    }
  }

  _scheduleRespawn() {
    if (!this._running) return;
    if (this._respawnTimer) clearTimeout(this._respawnTimer);
    this._respawnTimer = setTimeout(() => {
      this._respawnTimer = null;
      if (this._running) {
        this._initReceived = false;
        this._spawnPersistent();
      }
    }, this._respawnDelay);
  }

  // ── Message handler ──────────────────────────────────────────────────

  _handlePersistentMsg(msg) {
    try {
      switch (msg.type) {
        case 'init':
          this._handleInit(msg);
          break;
        case 'new_message':
          this._handleNewMessage(msg);
          break;
        case 'status':
          this._handleStatus(msg);
          break;
        case 'error':
          this._onStatus(chalk.yellow(`[WeChat/PS] ${msg.msg || '(无详情)'}`));
          break;
      }
    } catch {
      // Never let a bad message crash the Node.js side
    }
  }

  _handleInit(msg) {
    const contact = msg.activeContact || msg.title || '微信';
    const contactsStr = (msg.availableContacts && msg.availableContacts.length > 0)
      ? ` (扫描到${msg.contactCount || msg.availableContacts.length}个: ${msg.availableContacts.slice(0, 8).join(', ')})` : '';

    if (!this._statusShown.connected) {
      this._onStatus(`[WeChat] 持久监听已就绪 — ${contact}${contactsStr}`);
      this._statusShown = { not_running: false, window_not_found: false, connected: true };
    }

    this._lastActiveContact = msg.activeContact || '';
    this._lastAvailableContacts = msg.availableContacts || [];
    this._initReceived = true;
  }

  _handleNewMessage(msg) {
    const contact = msg.contact || '微信';
    const rawText = msg.text || '';
    const text = stripOwnPreviewPrefix(rawText);

    if (isIgnoredWechatContact(contact)) return;
    if (!text) return;
    if (isOwnPreview(rawText)) return;

    // [N条] placeholder guard
    if (/^\[\d+条\]$/.test(text.trim()) || /^\d+条$/.test(text.trim())) {
      return;
    }

    // Per-contact sent history: suppress self-send echo.
    // ── First check the detected contact's own history ──
    const sentArr = _sentHistory.get(contact);
    if (sentArr && sentArr.length > 0) {
      const idx = sentArr.findIndex(t => text.trim() === t.trim());
      if (idx !== -1) {
        sentArr.splice(idx, 1);
        if (sentArr.length === 0) _sentHistory.delete(contact);
        return;
      }
    }
    // ── Cross-contact check: the message may have landed on a different
    // contact if the send script's contact switch failed. Scan ALL sent
    // histories to catch self-sent echo on the wrong recipient. ──
    for (const [otherContact, otherTexts] of _sentHistory) {
      if (otherContact === contact) continue;
      const idx = otherTexts.findIndex(t => text.trim() === t.trim());
      if (idx !== -1) {
        otherTexts.splice(idx, 1);
        if (otherTexts.length === 0) _sentHistory.delete(otherContact);
        return;
      }
    }

    // System message filter
    if (/^\[微信红包\]|^你撤回了一条消息|^\[链接\]|^\[图片\]|^\[视频\]|^\[动画表情\]|^\[文件\]|^\[语音\]/.test(text.trim())) {
      return;
    }

    // Suppress first notification after manual cache reset
    if (this._resetContacts.has(contact)) {
      this._resetContacts.delete(contact);
      return;
    }

    // Fire immediate real-time notification
    try { this._onNewMessage(contact, text); } catch { }

    // Generate AI reply for this contact.
    // Background-only is the default: skip fetchLocalWechatHistory to
    // avoid the pop-up from buildUiaScript's SetWindowVisualState/SetFocus.
    // Set ARKTERM_WECHAT_BACKGROUND_ONLY=0 to re-enable foreground fallback.
    const self = this;
    const backgroundOnly = process.env.ARKTERM_WECHAT_BACKGROUND_ONLY !== '0';
    (async () => {
      try {
        let conversation = [];
        if (!backgroundOnly) {
          try {
            const history = await fetchLocalWechatHistory(contact);
            if (history && Array.isArray(history.conversation)) {
              conversation = history.conversation;
            }
          } catch { }
        }
        const reply = await self._generateAIReply(contact, text, conversation);
        self._onMessage(contact, text, reply);
      } catch {
        const fallback = LOCAL_FALLBACKS[Math.floor(Math.random() * LOCAL_FALLBACKS.length)];
        self._onMessage(contact, text, fallback);
      }
    })();
  }

  _handleStatus(msg) {
    if (msg.code === 'not_running') {
      if (!this._statusShown.not_running) {
        this._onStatus('[WeChat] 微信未运行，正在等待启动...');
        this._statusShown = { not_running: true, window_not_found: false, connected: false };
      }
    } else if (msg.code === 'window_not_found') {
      if (!this._statusShown.window_not_found) {
        this._onStatus('[WeChat] 检测到微信进程，但无法定位主窗口。');
        this._statusShown = { not_running: false, window_not_found: true, connected: false };
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  async _generateAIReply(friendName, message, conversation) {
    if (!this._client || !this._modelId) {
      throw new Error('No AI client configured');
    }

    const myMessages = (conversation || [])
      .filter((m) => m.role === 'me')
      .map((m) => m.text);
    const styleProfile = buildStyleProfile(myMessages);

    const fewShotBlock = buildFewShotPrompt(conversation);

    const systemPrompt = [
      USER_PERSONA,
      styleProfile,
      fewShotBlock,
    ].filter(Boolean).join('\n');

    const response = await this._client.chat.completions.create({
      model: this._modelId,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: `朋友${friendName}刚刚发来微信："${message}"\n请以用户的口吻，用15字以内简短回复。要求与用户历史风格完全一致。`,
        },
      ],
      max_tokens: 60,
      temperature: 0.9,
      stream: false,
    });

    const text = response.choices?.[0]?.message?.content || '';
    return text.replace(/^["'「『]|["'」』]$/g, '').trim().slice(0, 50) || LOCAL_FALLBACKS[0];
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Cleanup script — safety net: restores WeChat from legacy WS_EX_LAYERED ghost mode (no longer set, but may persist from older versions)
// ═══════════════════════════════════════════════════════════════════════════

const _cleanupPsContent = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'

# ── WeChatRadarCleanup — full descriptive class name, type guard ──────────
if (-not ('WeChatRadarCleanup' -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WeChatRadarCleanup {
    [DllImport("user32.dll")]
    public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
    [DllImport("user32.dll")]
    public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);
    [DllImport("user32.dll")]
    public static extern bool SetLayeredWindowAttributes(IntPtr hwnd, uint crKey, byte bAlpha, uint dwFlags);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
}
"@
}

$h = (Get-Process -Name WeChat,Weixin -ErrorAction SilentlyContinue | Select -First 1).MainWindowHandle
if ($h -ne [IntPtr]::Zero) {
    # Remove WS_EX_LAYERED (0x80000) from extended style
    $exStyle = [WeChatRadarCleanup]::GetWindowLong($h, -20)
    if ($exStyle -band 0x00080000) {
        [WeChatRadarCleanup]::SetWindowLong($h, -20, $exStyle -band -bnot 0x00080000)
    }
    # Restore full opacity (alpha = 255)
    [WeChatRadarCleanup]::SetLayeredWindowAttributes($h, 0, 255, 0x2)
    # Remove from top of Z-order: HWND_NOTOPMOST(-2) | SWP_NOMOVE(0x0002) | SWP_NOSIZE(0x0001) = 0x0003
    [WeChatRadarCleanup]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0003)
}
`;
try { fs.writeFileSync(_cleanupScriptPath, _cleanupPsContent, 'utf-8'); } catch { /* best-effort */ }

function restoreWeChatWindow() {
  try {
    require('child_process').execFileSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', _cleanupScriptPath],
      { windowsHide: true, timeout: 3000 }
    );
  } catch { /* best-effort */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// Exit trap — restore WeChat + kill zombies + clean temp files
// ═══════════════════════════════════════════════════════════════════════════

let _activeChildPid = null;
const _trackChild = (cp) => { if (cp && cp.pid) _activeChildPid = cp.pid; };
const _untrackChild = () => { _activeChildPid = null; };

process.once('exit', () => {
  // Safety: restore WeChat from legacy ghost mode
  restoreWeChatWindow();
  // Kill lingering PowerShell children
  if (_activeChildPid) {
    try {
      require('child_process').execSync(
        `taskkill /F /PID ${_activeChildPid} /T 2>nul`, { windowsHide: true });
    } catch { }
  }
  // Clean up temp cleanup script (radar script is permanent, don't delete)
  try { fs.unlinkSync(_cleanupScriptPath); } catch { }
});

module.exports = { WeChatMonitor, USER_PERSONA, fetchLocalWechatHistory, sendWechatMessage, _trackChild, _untrackChild };
