# ArkTerm WeChat Persistent Radar
# Keeps WeChat UIA tree alive via lightweight SetWindowPos refresh (NO transparency)
# Outputs JSON lines to stdout for Node.js readline consumption

param(
    [string]$TargetContact = '',
    [int]$MaxContacts = 30
)

# Force UTF-8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
$PSDefaultParameterValues['*:Encoding'] = 'utf8'
$ErrorActionPreference = 'SilentlyContinue'

# Load UIA assemblies
try {
    Add-Type -AssemblyName UIAutomationClient -ErrorAction Stop
    Add-Type -AssemblyName UIAutomationTypes -ErrorAction Stop
} catch {
    $err = @{ type = 'error'; msg = "FATAL: Cannot load UIA assemblies: $($_.Exception.Message)" }
    Write-Output (ConvertTo-Json $err -Compress)
    exit 1
}
Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue

# ArkRadarWin32 — minimal Win32 helpers (NO transparency / NO WS_EX_LAYERED manipulation)
if (-not ('ArkRadarWin32' -as [type])) {
    $typeDef = @'
using System;
using System.Runtime.InteropServices;
public class ArkRadarWin32 {
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
}
'@
    Add-Type -TypeDefinition $typeDef
    if (-not ('ArkRadarWin32' -as [type])) {
        $err = @{ type = 'error'; msg = 'FATAL: ArkRadarWin32 type failed to compile' }
        Write-Output (ConvertTo-Json $err -Compress)
        exit 1
    }
}

# Win32 window-management constants (no transparency)
$SW_SHOW         = 5
$HWND_TOP        = [IntPtr]::Zero
$SWP_NOSIZE      = 0x0001
$SWP_NOMOVE      = 0x0002
$SWP_NOACTIVATE  = 0x0010
$SWP_SHOWWINDOW  = 0x0040

# Defense-in-depth trap
trap {
    $trapMsg = ''
    try { $trapMsg = $_.Exception.Message -replace "\n", " " -replace "\r", "" } catch { $trapMsg = 'unknown trap' }
    $trapOut = @{ type = 'error'; msg = "TRAP: $trapMsg" }
    try { Write-Output (ConvertTo-Json $trapOut -Compress) } catch { }
    continue
}

# Helper: sanitize text to single-line
function Sanitize-Text($raw) {
    if (-not $raw) { return '' }
    return ($raw -replace "\n", " " -replace "\r", " " -replace "\t", " ").Trim()
}

function Get-ChildItemsByControlType($container, $itemCond) {
    try {
        $items = $container.FindAll([Windows.Automation.TreeScope]::Children, $itemCond)
        if ($items -and $items.Count -gt 0) { return @($items) }
    } catch { }

    try {
        $items = $container.FindAll([Windows.Automation.TreeScope]::Descendants, $itemCond)
        if ($items -and $items.Count -gt 0) { return @($items) }
    } catch { }

    return @()
}

function Get-ContactParts($rawName) {
    $result = @{ contact = ''; preview = ''; unread = 0; time = '' }
    if (-not $rawName) { return $result }

    $lines = @($rawName -split "\r?\n" | Where-Object { $_.Trim().Length -gt 0 })
    if ($lines.Count -lt 1) { return $result }

    $result.contact = $lines[0].Trim()

    for ($li = 1; $li -lt $lines.Count; $li++) {
        $l = $lines[$li].Trim()
        if ($l -match '\[(\d+)条\]') {
            $result.unread = [int]$Matches[1]
        } elseif ($l -match '^(\d+)条$') {
            $result.unread = [int]$Matches[1]
        } elseif ($l -match '^\d{1,2}:\d{2}$' -or $l -match '^(昨天|星期.|周.|上午|下午|晚上|凌晨|早上)') {
            if ($result.time.Length -eq 0) { $result.time = $l }
        } elseif ($l.Length -gt 0 -and $l -notmatch '^\d+$') {
            if ($result.preview.Length -eq 0) { $result.preview = $l }
        }
    }

    if ($result.unread -eq 0 -and $rawName -match '\[(\d+)条\]') {
        $result.unread = [int]$Matches[1]
    }

    return $result
}

function Test-IgnoredContactName($contactName) {
    if (-not $contactName) { return $true }
    return ($contactName -match '^(微信|WeChat|通讯录|发现|朋友圈|视频号|搜一搜|小程序|设置|看一看|搜狗输入法|表情|收藏|卡包|相册|直播|视频|文件传输助手|微信支付|公众号|服务号|订阅号)$')
}

# Per-contact state
$script:allContactCache   = @{}
$script:sidebarItemErrors = 0
$isFirstScan              = $true
$scanFailStreak           = 0
$MAX_FAIL_STREAK          = 10
$lastNotRunning           = $false
$lastWindowNotFound       = $false

# ====== MAIN MONITORING LOOP ======
while ($true) {
    try {
        # 1. Get WeChat process
        $proc = $null
        try {
            $proc = Get-Process | Where-Object {
                $_.Name -eq 'Weixin' -or $_.Name -eq 'weixin' -or
                $_.Name -eq 'WeChat' -or $_.Name -eq 'WeChatAppEx'
            } | Select-Object -First 1
        } catch {
            Write-Error "[Radar] Get-Process failed: $($_.Exception.Message)"
        }

        if (-not $proc) {
            if (-not $lastNotRunning) {
                $out = @{ type = 'status'; code = 'not_running' }
                Write-Output (ConvertTo-Json $out -Compress)
                $lastNotRunning = $true
                $lastWindowNotFound = $false
                $isFirstScan = $true
            }
            Start-Sleep -Milliseconds 3000
            continue
        }

        # 2. Locate WeChat main window (UIA + Win32 handle)
        $window = $null
        $wechatHwnd = [IntPtr]::Zero
        try {
            $wechatHwnd = $proc.MainWindowHandle
            if ($wechatHwnd -ne [IntPtr]::Zero) {
                $window = [Windows.Automation.AutomationElement]::FromHandle($wechatHwnd)
            }
        } catch {
            Write-Error "[Radar] FromHandle failed: $($_.Exception.Message)"
        }

        if (-not $window) {
            try {
                $root = [Windows.Automation.AutomationElement]::RootElement
                $winCond = New-Object Windows.Automation.OrCondition(
                    (New-Object Windows.Automation.PropertyCondition(
                        [Windows.Automation.AutomationElement]::ClassNameProperty, 'WeChatMainWndForPC')),
                    (New-Object Windows.Automation.PropertyCondition(
                        [Windows.Automation.AutomationElement]::NameProperty, '微信'))
                )
                $candidates = $root.FindAll([Windows.Automation.TreeScope]::Children, $winCond)
                foreach ($c in $candidates) {
                    try {
                        if ($c.Current.ClassName -eq 'WeChatMainWndForPC' -or $c.Current.Name -match '微信') {
                            $window = $c
                            try { $wechatHwnd = [IntPtr]($c.Current.NativeWindowHandle) } catch { }
                            break
                        }
                    } catch { }
                }
            } catch {
                Write-Error "[Radar] RootElement search failed: $($_.Exception.Message)"
            }

            if (-not $window) {
                try {
                    $allChildren = $root.FindAll([Windows.Automation.TreeScope]::Children,
                        [Windows.Automation.Condition]::TrueCondition)
                    foreach ($c in $allChildren) {
                        try {
                            if ($c.Current.ClassName -eq 'WeChatMainWndForPC' -or $c.Current.Name -match '微信') {
                                $window = $c
                                try { $wechatHwnd = [IntPtr]($c.Current.NativeWindowHandle) } catch { }
                                break
                            }
                        } catch { }
                    }
                } catch {
                    Write-Error "[Radar] TrueCondition fallback failed: $($_.Exception.Message)"
                }
            }
        }

        if (-not $window) {
            if (-not $lastWindowNotFound) {
                $out = @{ type = 'status'; code = 'window_not_found' }
                Write-Output (ConvertTo-Json $out -Compress)
                $lastWindowNotFound = $true
                $lastNotRunning = $false
                $isFirstScan = $true
            }
            Start-Sleep -Milliseconds 3000
            continue
        }

        $scanFailStreak = 0
        $lastNotRunning = $false
        $lastWindowNotFound = $false

        # 3. Read window info + restore from minimized
        $title = ''
        $windowRect = $null
        try { $title = $window.Current.Name } catch { }
        try { $windowRect = $window.Current.BoundingRectangle } catch { }

        $wasMinimized = $false
        $backgroundOnly = ($env:ARKTERM_WECHAT_BACKGROUND_ONLY -eq '1')
        try {
            $wp = $window.GetCurrentPattern([Windows.Automation.WindowPattern]::Pattern)
            if ($wp -and $wp.Current.WindowVisualState -eq 'Minimized') {
                if (-not $backgroundOnly) {
                    $wp.SetWindowVisualState([Windows.Automation.WindowVisualState]::Normal)
                    $wasMinimized = $true
                    Start-Sleep -Milliseconds 300
                    try { $windowRect = $window.Current.BoundingRectangle } catch { }
                }
            }
        } catch {
            Write-Error "[Radar] WindowPattern restore failed: $($_.Exception.Message)"
        }

        if (-not $windowRect) {
            Start-Sleep -Milliseconds 1500
            continue
        }

        # 3.5 Lightweight UIA tree refresh — prevent Chromium occlusion culling
        # Uses SetWindowPos with NOACTIVATE|NOSIZE|NOMOVE|SHOWWINDOW — visually a no-op
        # but tells DWM to keep this window in the active rendering pipeline
        if ($wechatHwnd -ne [IntPtr]::Zero) {
            try {
                $refreshFlags = $SWP_NOACTIVATE -bor $SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_SHOWWINDOW
                [ArkRadarWin32]::SetWindowPos($wechatHwnd, $HWND_TOP, 0, 0, 0, 0, $refreshFlags) | Out-Null
            } catch { }
        }

        # 4. Sidebar Radar - scan left-sidebar contacts (fully visible, no ghost mode)
        $activeContact = $null
        $availableContacts = @()
        $sidebarData = @()
        $sidebarFound = $false

        try {
            $itemCond = New-Object Windows.Automation.OrCondition(
                (New-Object Windows.Automation.PropertyCondition(
                    [Windows.Automation.AutomationElement]::ControlTypeProperty,
                    [Windows.Automation.ControlType]::ListItem)),
                (New-Object Windows.Automation.PropertyCondition(
                    [Windows.Automation.AutomationElement]::ControlTypeProperty,
                    [Windows.Automation.ControlType]::TreeItem))
            )

            $containerTypes = @(
                [Windows.Automation.ControlType]::List,
                [Windows.Automation.ControlType]::Tree,
                [Windows.Automation.ControlType]::DataGrid
            )

            $candidates = @()
            foreach ($ct in $containerTypes) {
                try {
                    $ctCond = New-Object Windows.Automation.PropertyCondition(
                        [Windows.Automation.AutomationElement]::ControlTypeProperty, $ct)
                    $containers = $window.FindAll([Windows.Automation.TreeScope]::Descendants, $ctCond)
                } catch {
                    Write-Error "[Radar] Container FindAll failed (ct=$ct): $($_.Exception.Message)"
                    continue
                }

                foreach ($container in $containers) {
                    try {
                        $cr = $container.Current.BoundingRectangle
                        if (-not $cr -or $cr.Width -le 0 -or $cr.Height -le 0) { continue }
                        $inLeft = ($cr.X -lt ($windowRect.X + $windowRect.Width * 0.45))
                        $tallEnough = ($cr.Height -gt ($windowRect.Height * 0.20))
                        if (-not $inLeft -or -not $tallEnough) { continue }

                        $items = @(Get-ChildItemsByControlType $container $itemCond)
                        if ($items.Count -lt 1) { continue }

                        $valid = 0
                        foreach ($item in $items) {
                            try {
                                $parts = Get-ContactParts $item.Current.Name
                                $cn = $parts.contact
                                if (-not $cn -or $cn.Length -lt 1) { continue }
                                if (Test-IgnoredContactName $cn) { continue }
                                $valid++
                            } catch { }
                        }
                        if ($valid -lt 1) { continue }

                        $score = ($valid * 1000) + [int]$cr.Height - [Math]::Abs([int]($cr.X - $windowRect.X))
                        $candidates += @{ container = $container; items = $items; score = $score }
                    } catch {
                        Write-Error "[Radar] Container processing failed: $($_.Exception.Message)"
                    }
                }
            }

            $best = $candidates | Sort-Object -Property score -Descending | Select-Object -First 1
            if ($best) {
                $sidebarFound = $true
                $items = @($best.items)
                $topCount = [Math]::Min([Math]::Max(1, $MaxContacts), $items.Count)
                for ($i = 0; $i -lt $topCount; $i++) {
                    $item = $items[$i]
                    try {
                        $parts = Get-ContactParts $item.Current.Name
                        $contactName = $parts.contact
                        if (-not $contactName -or $contactName.Length -lt 1) { continue }
                        if (Test-IgnoredContactName $contactName) { continue }

                        if ($availableContacts -notcontains $contactName) {
                            $availableContacts += $contactName
                        }

                        $isSelected = $false
                        try {
                            $sel = $item.GetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern)
                            if ($sel -and $sel.Current.IsSelected) {
                                $isSelected = $true
                                $activeContact = $contactName
                            }
                        } catch { }

                        $sidebarData += @{
                            contact    = (Sanitize-Text $contactName)
                            preview    = (Sanitize-Text $parts.preview)
                            unread     = $parts.unread
                            time       = (Sanitize-Text $parts.time)
                            isSelected = $isSelected
                        }
                    } catch {
                        $script:sidebarItemErrors++
                    }
                }
            }
        } catch {
            Write-Error "[Radar] Sidebar scan outer failure: $($_.Exception.Message)"
        }

        if ($script:sidebarItemErrors -gt 0) {
            Write-Error "[Radar] $($script:sidebarItemErrors) sidebar items failed this cycle"
            $script:sidebarItemErrors = 0
        }

        # 6. Per-contact diff with targeted self-sent filtering
        if ($isFirstScan) {
            foreach ($s in $sidebarData) {
                $script:allContactCache[$s.contact] = @{ preview = $s.preview; unread = $s.unread; time = $s.time }
            }
            $out = @{
                type              = 'init'
                status            = 'ok'
                title             = $title
                activeContact     = if ($activeContact) { $activeContact } else { $null }
                availableContacts = @($availableContacts | Select-Object -Unique)
                contactCount      = $sidebarData.Count
                sidebarData       = @($sidebarData)
            }
            Write-Output (ConvertTo-Json $out -Compress -Depth 5)
            $isFirstScan = $false
        }
        else {
            $diffCount = 0

            foreach ($s in $sidebarData) {
                $name = $s.contact
                $curPreview = $s.preview
                if (-not $name -or $name.Length -eq 0) { continue }

                # Filter unread-count-only placeholders
                if ($curPreview -match '^\[\d+条\]$|^\d+条$') { continue }
                # Filter empty previews (contact with no recent messages)
                if ($curPreview.Length -eq 0) { continue }

                if (-not $script:allContactCache.ContainsKey($name)) {
                    # New contact appeared in top-N — first time seeing it
                    $script:allContactCache[$name] = @{ preview = $curPreview; unread = $s.unread; time = $s.time }
                    $out = @{ type = 'new_message'; contact = $name; text = $curPreview }
                    Write-Output (ConvertTo-Json $out -Compress)
                    $diffCount++
                }
                else {
                    $cached = $script:allContactCache[$name]
                    $previewChanged = ($curPreview -ne $cached.preview)
                    $unreadIncreased = ($s.unread -gt 0 -and $s.unread -gt $cached.unread)

                    if (-not $previewChanged -and -not $unreadIncreased) { continue }

                    # ── Determine if this change is self-sent ──────────────
                    $isSelfSent = $false

                    if ($curPreview -match '^(你|我|Me|You)\s*[:：]') {
                        # Sidebar explicitly marks messages sent by this account.
                        $isSelfSent = $true
                    }

                    if ($isSelfSent) {
                        # Update cache silently — don't emit new_message for our own messages
                        $script:allContactCache[$name] = @{ preview = $curPreview; unread = $s.unread; time = $s.time }
                    }
                    else {
                        $out = @{ type = 'new_message'; contact = $name; text = $curPreview }
                        Write-Output (ConvertTo-Json $out -Compress)
                        $script:allContactCache[$name] = @{ preview = $curPreview; unread = $s.unread; time = $s.time }
                        $diffCount++
                    }
                }
            }
        }

        $scanFailStreak = 0

    } catch {
        $errMsg = ''
        try { $errMsg = ($_.Exception.Message -replace "\n", " " -replace "\r", "") } catch { $errMsg = 'unknown error' }
        if ($errMsg.Length -gt 300) { $errMsg = $errMsg.Substring(0, 300) }
        $errOut = @{ type = 'error'; msg = $errMsg }
        try { Write-Output (ConvertTo-Json $errOut -Compress) } catch { }
        $scanFailStreak++
        if ($scanFailStreak -gt $MAX_FAIL_STREAK) {
            $isFirstScan = $true
            $script:allContactCache = @{}
            $scanFailStreak = 0
        }
    }

    Start-Sleep -Milliseconds 1800
}

