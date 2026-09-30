# Test streaming mét tools: komen tool_calls als delta's door, en levert de stream usage-cijfers?
# Leest .env.local; print de API-key nooit.
#   powershell -ExecutionPolicy Bypass -File scripts\test-streaming.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$vars = @{}
foreach ($line in Get-Content (Join-Path $root ".env.local")) {
  if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$') { $vars[$matches[1]] = $matches[2].Trim() }
}
$base = $vars["GONKA_BASE_URL"].TrimEnd("/")
$headers = @{ Authorization = "Bearer $($vars["GONKA_API_KEY"])"; "Content-Type" = "application/json" }
$tool = @{
  type = "function"
  function = @{ name = "get_weather"; description = "Weer voor een stad"; parameters = @{ type = "object"; properties = @{ city = @{ type = "string" } }; required = @("city") } }
}
$body = @{
  model = $vars["GONKA_MODEL"]
  messages = @(@{ role = "user"; content = "Wat is het weer in Utrecht? Gebruik de tool." })
  tools = @($tool)
  stream = $true
  stream_options = @{ include_usage = $true }
  max_tokens = 400
} | ConvertTo-Json -Depth 10 -Compress

$resp = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$base/chat/completions" -Headers $headers -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 90
$raw = if ($resp.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($resp.Content) } else { [string]$resp.Content }
"status            $($resp.StatusCode) $($resp.Headers['Content-Type'])"
"raw_preview       $($raw.Substring(0, [Math]::Min(300, $raw.Length)) -replace "`r?`n", ' | ')"
$lines = @($raw -split "`n" | Where-Object { $_.StartsWith("data:") -and -not $_.Contains("[DONE]") })

$toolChunks = 0; $argText = ""; $usage = $null; $reasoningChunks = 0; $content = ""; $models = @{}
foreach ($l in $lines) {
  $j = $l.Substring(5).Trim() | ConvertFrom-Json
  if ($j.model) { $models[$j.model] = $true }
  if ($j.usage) { $usage = $j.usage }
  if (-not $j.choices -or -not $j.choices.Count) { continue }
  $d = $j.choices[0].delta
  if ($d.tool_calls) { $toolChunks++; $argText += $d.tool_calls[0].function.arguments }
  if ($d.reasoning_content -or $d.reasoning) { $reasoningChunks++ }
  if ($d.content) { $content += $d.content }
}
"chunks            $($lines.Count)"
"tool_call_chunks  $toolChunks"
"tool_args         $argText"
"reasoning_chunks  $reasoningChunks"
"content_chars     $($content.Length)"
"content_has_think $($content -match '<think>')"
"requested_model   $($vars["GONKA_MODEL"])"
"served_models     $($models.Keys -join ', ')"
"usage             $($usage | ConvertTo-Json -Compress)"
