# Tunnel SSH verso il Postgres della VM Oracle, per sviluppare in locale.
# Il database ascolta solo su localhost della VM: qui la porta locale 15432 viene inoltrata
# a 127.0.0.1:5432 della VM. Il backend/.env locale punta a 127.0.0.1:15432.
# Nello stesso tunnel la porta locale 18101 va a whisper.cpp della VM (127.0.0.1:8101): la usa
# solo l'Assistente PM in locale (ASSISTENTE_PM_WHISPER_CPP_URL=http://127.0.0.1:18101).
# La porta locale 11435 va a Ollama della VM (127.0.0.1:11434): la usa solo l'Assistente PM
# con la voce «Projexa» (agente Pm projexa) in locale (ASSISTENTE_PM_OLLAMA_URL=http://127.0.0.1:11435).
# Uso: lasciare aperta questa finestra mentre si usa il backend in locale (Ctrl+C per chiudere).
param(
  [string]$Key = "$env:USERPROFILE\.ssh\ssh-key-2026-09-25.key",
  [string]$VmHost = "129.152.0.49",
  [int]$LocalPort = 15432,
  [int]$WhisperCppPort = 18101,
  [int]$OllamaPort = 11435
)
Write-Host "Tunnel Postgres: 127.0.0.1:$LocalPort -> $VmHost (Ctrl+C per chiudere)"
Write-Host "Tunnel whisper.cpp (Assistente PM): 127.0.0.1:$WhisperCppPort -> $VmHost"
Write-Host "Tunnel Ollama (Pm projexa): 127.0.0.1:$OllamaPort -> $VmHost"
ssh -i $Key -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 `
  -L "127.0.0.1:${LocalPort}:127.0.0.1:5432" `
  -L "127.0.0.1:${WhisperCppPort}:127.0.0.1:8101" `
  -L "127.0.0.1:${OllamaPort}:127.0.0.1:11434" "opc@$VmHost"
