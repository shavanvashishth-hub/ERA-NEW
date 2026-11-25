Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

# Open Phone Link Calls view
Start-Process "ms-phone:calls"
Start-Sleep -Seconds 1

$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, 'WinUIDesktopWin32WindowClass')
$win = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)

if ($win) {
    Write-Host "Found Phone Link Window: $($win.Current.Name)"
    $btnCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
    $buttons = $win.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
    Write-Host "Total buttons found: $($buttons.Count)"
    foreach ($b in $buttons) {
        $rect = $b.Current.BoundingRectangle
        if ($b.Current.Name -or $b.Current.AutomationId) {
            Write-Host ("Button: Name='{0}' Id='{1}' Rect=({2},{3},{4},{5})" -f $b.Current.Name, $b.Current.AutomationId, $rect.X, $rect.Y, $rect.Width, $rect.Height)
        }
    }
} else {
    Write-Host "Phone Link Window not found!"
}
