$ErrorActionPreference = 'Stop'
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Set-Service sshd -StartupType Automatic
Start-Service sshd
New-ItemProperty HKLM:\SOFTWARE\OpenSSH -Name DefaultShell -PropertyType String -Force `
  -Value "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
# OpenSSH reads an administrator's keys from here, and only while Administrators and SYSTEM alone can access it.
$keys = "$env:ProgramData\ssh\administrators_authorized_keys"
Copy-Item C:\OEM\authorized_keys $keys
icacls $keys /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F'
if (-not (Get-NetFirewallRule -Name OpenSSH-Server-In-TCP -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name OpenSSH-Server-In-TCP -DisplayName 'OpenSSH Server' -Protocol TCP -LocalPort 22 -Action Allow
}
