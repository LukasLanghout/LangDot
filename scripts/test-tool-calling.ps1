# Test of GONKA_MODEL tool calling doet in OpenAI-vorm (tool_calls in choices[0].message).
# Leest .env.local; print de API-key nooit.
#   powershell -ExecutionPolicy Bypass -File scripts\test-tool-calling.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root ".env.local"
$vars = @{}
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$') { $vars[$matches[1]] = $matches[2].Trim() }
  }
}
$key = $vars["GONKA_API_KEY"]; if (-not $key) { $key = $env:GONKA_API_KEY }
$base = $vars["GONKA_BASE_URL"]; if (-not $base) { $base = "https://api.gonkarouter.io/v1" }
$model = $vars["GONKA_MODEL"]; if (-not $model) { $model = "zai-org/GLM-5.3-Flash" }
if (-not $key) { Write-Output "FAIL: GONKA_API_KEY ontbreekt in .env.local"; exit 1 }
$base = $base.TrimEnd("/")
$headers = @{ Authorization = "Bearer $key"; "Content-Type" = "application/json" }
$results = [ordered]@{}

function Post-Json($body) {
  $json = $body | ConvertTo-Json -Depth 20 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  return Invoke-RestMethod -UseBasicParsing -Method Post -Uri "$base/chat/completions" -Headers $headers -Body $bytes -TimeoutSec 90
}

# 1. Bestaat het model?
try {
  $models = Invoke-RestMethod -UseBasicParsing -Uri "$base/models" -Headers $headers -TimeoutSec 30
  $ids = @($models.data | ForEach-Object { $_.id })
  $results["models_endpoint"] = "OK ($($ids.Count) modellen)"
  $results["model_exists"] = if ($ids -contains $model) { "OK" } else { "FAIL: '$model' staat niet in GET /models" }
} catch { $results["models_endpoint"] = "FAIL: $($_.Exception.Message)" }

# 2. Tool calling: het model moet get_weather aanroepen met geldige JSON {"city": "..."}.
$tool = @{
  type = "function"
  function = @{
    name = "get_weather"
    description = "Geeft het actuele weer voor een stad."
    parameters = @{ type = "object"; properties = @{ city = @{ type = "string" } }; required = @("city") }
  }
}
$passes = 0; $runs = 3
for ($i = 1; $i -le $runs; $i++) {
  try {
    $r = Post-Json @{
      model = $model
      messages = @(@{ role = "user"; content = "Wat is het weer in Utrecht? Gebruik de tool." })
      tools = @($tool)
      tool_choice = "auto"
      max_tokens = 400
    }
    $msg = $r.choices[0].message
    $call = @($msg.tool_calls)[0]
    if (-not $call) { $results["tool_call_run$i"] = "FAIL: geen tool_calls; content='$("$($msg.content)".Substring(0, [Math]::Min(120, "$($msg.content)".Length)))'"; continue }
    $parsed = $call.function.arguments | ConvertFrom-Json
    if ($call.function.name -eq "get_weather" -and $parsed.city) {
      $passes++
      $results["tool_call_run$i"] = "OK (name=get_weather, city=$($parsed.city), id=$([bool]$call.id), usage=$($r.usage.total_tokens) tokens, served_by=$($r.model))"
    } else { $results["tool_call_run$i"] = "FAIL: verkeerde naam/argumenten: $($call.function.name) $($call.function.arguments)" }
  } catch { $results["tool_call_run$i"] = "FAIL: $($_.Exception.Message)" }
}

# 3. Vervolgbeurt: tool-resultaat terugsturen, model moet een tekstantwoord geven.
try {
  $r1 = Post-Json @{ model = $model; messages = @(@{ role = "user"; content = "Wat is het weer in Utrecht? Gebruik de tool." }); tools = @($tool); max_tokens = 400 }
  $c = @($r1.choices[0].message.tool_calls)[0]
  if ($c) {
    $r2 = Post-Json @{
      model = $model
      messages = @(
        @{ role = "user"; content = "Wat is het weer in Utrecht? Gebruik de tool." },
        @{ role = "assistant"; content = $null; tool_calls = @($c) },
        @{ role = "tool"; tool_call_id = $c.id; content = '{"city":"Utrecht","temp_c":14,"sky":"bewolkt"}' }
      )
      tools = @($tool)
      max_tokens = 400
    }
    $txt = "$($r2.choices[0].message.content)"
    $results["tool_result_roundtrip"] = if ($txt -match "14") { "OK" } else { "TWIJFEL: antwoord noemt 14 graden niet: '$($txt.Substring(0, [Math]::Min(120, $txt.Length)))'" }
  } else { $results["tool_result_roundtrip"] = "OVERGESLAGEN (geen tool call)" }
} catch { $results["tool_result_roundtrip"] = "FAIL: $($_.Exception.Message)" }

# 4. Geforceerde tool (tool_choice = function).
try {
  $r = Post-Json @{ model = $model; messages = @(@{ role = "user"; content = "Hoi" }); tools = @($tool); tool_choice = @{ type = "function"; function = @{ name = "get_weather" } }; max_tokens = 300 }
  $results["forced_tool_choice"] = if (@($r.choices[0].message.tool_calls).Count) { "OK" } else { "FAIL: geen tool call ondanks tool_choice" }
} catch { $results["forced_tool_choice"] = "FAIL: $($_.Exception.Message)" }

# 5. Streaming.
try {
  $json = @{ model = $model; messages = @(@{ role = "user"; content = "Zeg alleen: hallo" }); stream = $true; max_tokens = 50 } | ConvertTo-Json -Compress
  $resp = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$base/chat/completions" -Headers $headers -Body ([Text.Encoding]::UTF8.GetBytes($json)) -TimeoutSec 60
  $chunks = @($resp.Content -split "`n" | Where-Object { $_ -like "data:*" })
  $results["streaming"] = if ($chunks.Count -gt 1) { "OK ($($chunks.Count) SSE-chunks)" } else { "FAIL: geen SSE-stream" }
} catch { $results["streaming"] = "FAIL: $($_.Exception.Message)" }

$results["summary"] = "$passes/$runs tool-call-runs geslaagd"
$results.GetEnumerator() | ForEach-Object { "{0,-22} {1}" -f $_.Key, $_.Value }
