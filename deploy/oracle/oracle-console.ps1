# Apre la console Oracle (Database Actions dell'Autonomous Database) "passando dalla VM".
# Il database accetta connessioni solo dall'IP della VM (lista di accesso), mentre l'IP
# del PC cambia: qui un tunnel SSH fa da proxy SOCKS (porta locale 1080) e una finestra
# di Edge separata (profilo a parte, il browser normale non viene toccato) esce su
# internet con l'IP della VM, 129.152.0.49.
# Uso: lasciare aperta questa finestra mentre si usa la console (Ctrl+C per chiudere).
param(
  [string]$Key = "$env:USERPROFILE\.ssh\ssh-key-2026-09-25.key",
  [string]$VmHost = "129.152.0.49",
  [int]$SocksPort = 1080,
  [string]$Url = "https://cloud.oracle.com"
)
$edge = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe"
$profilo = "$env:LOCALAPPDATA\projexa-oracle-console"

Write-Host "Proxy SOCKS 127.0.0.1:$SocksPort -> $VmHost (Ctrl+C per chiudere)"
$ssh = Start-Process ssh -NoNewWindow -PassThru -ArgumentList @(
  '-i', $Key, '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=30',
  '-D', "127.0.0.1:$SocksPort", "opc@$VmHost")
Start-Sleep -Seconds 3
if ($ssh.HasExited) { Write-Host "Tunnel non avviato (porta $SocksPort occupata o SSH non raggiungibile)"; exit 1 }

Start-Process $edge -ArgumentList @(
  "--user-data-dir=$profilo", "--proxy-server=socks5://127.0.0.1:$SocksPort", '--no-first-run', $Url)
try { Wait-Process -Id $ssh.Id } finally { if (-not $ssh.HasExited) { Stop-Process -Id $ssh.Id } }
