# tray.ps1 — Windows system tray host for service-remote
# Communicates with the Node.js parent via stdin/stdout JSON lines.
#
# stdin commands (JSON):
#   { "cmd": "status", "text": "OBS:on  X32:off  MIDI:on" }
#   { "cmd": "exit" }
#
# stdout events (JSON):
#   { "event": "open" }
#   { "event": "exit" }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Build a 16x16 solid-blue bitmap as the tray icon (no external file needed)
function New-TrayIcon {
    $bmp = New-Object System.Drawing.Bitmap 16, 16
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::FromArgb(0, 87, 166))
    $g.Dispose()
    return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

$icon = New-TrayIcon

$tray = New-Object System.Windows.Forms.NotifyIcon
$tray.Icon = $icon
$tray.Text = 'service-remote'
$tray.Visible = $true

# Context menu
$menu = New-Object System.Windows.Forms.ContextMenuStrip

$statusItem = New-Object System.Windows.Forms.ToolStripMenuItem
$statusItem.Text = 'OBS:off  X32:off  MIDI:off'
$statusItem.Enabled = $false
$null = $menu.Items.Add($statusItem)

$null = $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$openItem = New-Object System.Windows.Forms.ToolStripMenuItem
$openItem.Text = 'Open in Browser'
$openItem.add_Click({
    [Console]::Out.WriteLine('{"event":"open"}')
    [Console]::Out.Flush()
})
$null = $menu.Items.Add($openItem)

$null = $menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$exitItem = New-Object System.Windows.Forms.ToolStripMenuItem
$exitItem.Text = 'Exit'
$exitItem.add_Click({
    [Console]::Out.WriteLine('{"event":"exit"}')
    [Console]::Out.Flush()
    $tray.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})
$null = $menu.Items.Add($exitItem)

$tray.ContextMenuStrip = $menu

# Double-click also opens the browser
$tray.add_DoubleClick({
    [Console]::Out.WriteLine('{"event":"open"}')
    [Console]::Out.Flush()
})

# Read stdin commands on a background thread so the message pump stays responsive
$stdin = [Console]::In
$scriptBlock = {
    param($stdin, $statusItem, $tray, $menu)
    while ($true) {
        $line = $stdin.ReadLine()
        if ($null -eq $line) { break }
        $line = $line.Trim()
        if ($line -eq '') { continue }
        try {
            $msg = $line | ConvertFrom-Json
        } catch { continue }

        if ($msg.cmd -eq 'status') {
            # Marshal UI update back to the UI thread
            $tray.ContextMenuStrip.Invoke([Action]{
                $statusItem.Text = $msg.text
                $tray.Text = "service-remote — $($msg.text)"
            })
        } elseif ($msg.cmd -eq 'exit') {
            $tray.Visible = $false
            [System.Windows.Forms.Application]::Exit()
            break
        }
    }
    # stdin closed — parent process gone
    $tray.Visible = $false
    [System.Windows.Forms.Application]::Exit()
}

# Use a RunspacePool so we get a proper STA-compatible background thread
$rs = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
$rs.ApartmentState = 'MTA'
$rs.Open()
$ps = [System.Management.Automation.PowerShell]::Create()
$ps.Runspace = $rs
$null = $ps.AddScript($scriptBlock).AddArgument($stdin).AddArgument($statusItem).AddArgument($tray).AddArgument($menu)
$null = $ps.BeginInvoke()

[System.Windows.Forms.Application]::Run()

$rs.Close()
$tray.Dispose()
