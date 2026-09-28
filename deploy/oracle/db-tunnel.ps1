# Tunnel SSH verso il Postgres della VM Oracle, per sviluppare in locale.
# Il database ascolta solo su localhost della VM: qui la porta locale 15432 viene inoltrata
# a 127.0.0.1:5432 della VM. Il backend/.env locale punta a 127.0.0.1:15432.
# Uso: lasciare aperta questa finestra mentre si usa il backend in locale (Ctrl+C per chiudere).
param(
  [string]$Key = "$env:USERPROFILE\.ssh\ssh-key-2026-09-25.key",
  [string]$VmHost = "129.152.0.49",
  [int]$LocalPort = 15432
)
Write-Host "Tunnel Postgres: 127.0.0.1:$LocalPort -> $VmHost (Ctrl+C per chiudere)"
ssh -i $Key -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 `
  -L "127.0.0.1:${LocalPort}:127.0.0.1:5432" "opc@$VmHost"
