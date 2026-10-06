# Ronde 2 na een tool-call (zoals de chat-loop): wat zit er precies in de gestreamde content?
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
$msgs = @(
  @{ role = "system"; content = "Antwoord kort in het Nederlands." },
  @{ role = "user"; content = "Ik heb de oude schema's verwijderd." },
  @{ role = "assistant"; content = "<think>Even het geheugen checken."; tool_calls = @(@{ id = "call_1"; type = "function"; function = @{ name = "memory_read"; arguments = '{"query":"schema"}' } }) },
  @{ role = "tool"; tool_call_id = "call_1"; content = '{"memories":[]}' }
)
foreach ($i in 1..3) {
  $json = @{ model = $vars["GONKA_MODEL"]; messages = $msgs; tools = @($tool); stream = $true; max_tokens = 500 } | ConvertTo-Json -Depth 10 -Compress
  $resp = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$base/chat/completions" -Headers $headers -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 90
  $raw = if ($resp.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($resp.Content) } else { [string]$resp.Content }
  $content = ""
  foreach ($l in ($raw -split "`n" | Where-Object { $_.StartsWith("data:") -and -not $_.Contains("[DONE]") })) {
    $j = $l.Substring(5).Trim() | ConvertFrom-Json
    if ($j.choices -and $j.choices.Count -and $j.choices[0].delta.content) { $content += $j.choices[0].delta.content }
  }
  "--- run $i --- open=$($content.Contains('<think>')) close=$($content.Contains('</think>'))"
  ($content | ConvertTo-Json -Compress)
}
