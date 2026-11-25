Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement

# Find all buttons across open windows
$btnCond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
$buttons = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)

Write-Host "Total buttons found on desktop: $($buttons.Count)"

$callButtons = @()
foreach ($b in $buttons) {
    try {
        $name = $b.Current.Name
        $aid = $b.Current.AutomationId
        if ($name -match "accept|answer|decline|reject|end call|call on mobile|hang" -or $aid -match "accept|answer|decline|reject|end|call") {
            $rect = $b.Current.BoundingRectangle
            Write-Host ("Matched: Name='{0}' Id='{1}' Rect=({2},{3},{4},{5})" -f $name, $aid, $rect.X, $rect.Y, $rect.Width, $rect.Height)
            $callButtons += $b
        }
    } catch {}
}
