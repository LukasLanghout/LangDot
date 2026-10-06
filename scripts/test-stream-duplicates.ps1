# Stuurt GonkaRouter tijdens streaming tekst dubbel? Vergelijkt gestreamde tekst met niet-gestreamde.
# Leest .env.local; print de key nooit.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$vars = @{}
foreach ($line in Get-Content (Join-Path $root ".env.local")) {
  if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$') { $vars[$matches[1]] = $matches[2].Trim() }
}
$base = $vars["GONKA_BASE_URL"].TrimEnd("/")
$headers = @{ Authorization = "Bearer $($vars["GONKA_API_KEY"])"; "Content-Type" = "application/json" }
$tool = @{ type = "function"; function = @{ name = "memory_read"; description = "Lees geheugen"; parameters = @{ type = "object"; properties = @{ query = @{ type = "string" } } } } }

foreach ($withTools in @($false, $true)) {
  $body = @{
    model = $vars["GONKA_MODEL"]
    messages = @(@{ role = "system"; content = "Antwoord kort in het Nederlands." }, @{ role = "user"; content = "Ik heb de oude schema's verwijderd." })
    stream = $true
    stream_options = @{ include_usage = $true }
    max_tokens = 400
  }
  if ($withTools) { $body.tools = @($tool) }
  $json = $body | ConvertTo-Json -Depth 10 -Compress
  $resp = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$base/chat/completions" -Headers $headers -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 90
  $raw = if ($resp.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($resp.Content) } else { [string]$resp.Content }
  $lines = @($raw -split "`n" | Where-Object { $_.StartsWith("data:") -and -not $_.Contains("[DONE]") })
  $content = ""; $finishes = 0; $msgFields = 0
  foreach ($l in $lines) {
    $j = $l.Substring(5).Trim() | ConvertFrom-Json
    if (-not $j.choices -or -not $j.choices.Count) { continue }
    $ch = $j.choices[0]
    if ($ch.delta.content) { $content += $ch.delta.content }
    if ($ch.finish_reason) { $finishes++ }
    if ($ch.message) { $msgFields++ }
  }
  $visible = ($content -replace '(?s)<think>.*?</think>', '') -replace '(?s)<think>.*?\n{3,}', ''
  $visible = $visible.Trim()
  $half = [Math]::Floor($visible.Length / 2)
  $dup = $visible.Length -gt 10 -and ($visible.Substring(0, $half).Trim() -eq $visible.Substring($half).Trim())
  "--- tools=$withTools ---"
  "chunks=$($lines.Count) finish_chunks=$finishes chunks_met_message_veld=$msgFields"
  "zichtbaar_dubbel=$dup"
  "zichtbaar: " + ($visible -replace "`r?`n", " | ")
}
