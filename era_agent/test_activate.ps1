$wshell = New-Object -ComObject WScript.Shell
$res = $wshell.AppActivate('Notepad')
Write-Output "AppActivate result: $res"
