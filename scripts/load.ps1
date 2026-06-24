# Author: Nicholas Irvine  GitHub https://github.com/SaladStik  LinkedIn https://www.linkedin.com/in/nicholas-irvine-303ab5284/
# Submit many jobs fast to build a backlog and trigger autoscaling. Windows.
# Usage: .\scripts\load.ps1 [count] [baseurl]
param([int]$N = 30, [string]$Base = "https://localhost")

$ProgressPreference = "SilentlyContinue"
$s = New-Object Microsoft.PowerShell.Commands.WebRequestSession
Invoke-WebRequest -SkipCertificateCheck -Uri "$Base/api/login" -Method Post `
  -ContentType "application/json" -Body '{"username":"admin","password":"admin"}' `
  -WebSession $s | Out-Null

1..$N | ForEach-Object {
  Invoke-WebRequest -SkipCertificateCheck -Uri "$Base/api/jobs" -Method Post `
    -ContentType "application/json" -Body "{`"payload`":`"load $_`"}" `
    -WebSession $s | Out-Null
}
Write-Host "submitted $N jobs to $Base"
