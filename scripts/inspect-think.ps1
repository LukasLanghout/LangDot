# Onderzoekt hoe GONKA_MODEL zijn redenering (<think>) teruggeeft, streaming en niet-streaming.
# Leest .env.local; print de key nooit.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$vars = @{}
foreach ($line in Get-Content (Join-Path $root ".env.local")) {
  if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$') { $vars[$matches[1]] = $matches[2].Trim() }
}
$base = $vars["GONKA_BASE_URL"].TrimEnd("/")
$headers = @{ Authorization = "Bearer $($vars["GONKA_API_KEY"])"; "Content-Type" = "application/json" }
$q = "Hoeveel is 17 keer 3? Antwoord kort."

foreach ($i in 1..3) {
  $body = @{ model = $vars["GONKA_MODEL"]; messages = @(@{ role = "user"; content = $q }); max_tokens = 600 } | ConvertTo-Json -Depth 5 -Compress
  $r = Invoke-RestMethod -UseBasicParsing -Method Post -Uri "$base/chat/completions" -Headers $headers -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 90
  $m = $r.choices[0].message
  $c = "$($m.content)"
  "--- niet-streaming $i ---"
  "message_keys  " + (($m.PSObject.Properties | ForEach-Object { $_.Name }) -join ", ")
  "open=$($c.Contains('<think>')) close=$($c.Contains('</think>')) triple_nl=$($c.Contains("`n`n`n"))"
  "json          " + (($c | ConvertTo-Json -Compress) -replace '^(.{0,300}).*$', '$1')
}

$body = @{ model = $vars["GONKA_MODEL"]; messages = @(@{ role = "user"; content = $q }); max_tokens = 600; stream = $true } | ConvertTo-Json -Depth 5 -Compress
$resp = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$base/chat/completions" -Headers $headers -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 90
$raw = if ($resp.Content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($resp.Content) } else { [string]$resp.Content }
$content = ""; $keys = @{}
foreach ($l in ($raw -split "`n" | Where-Object { $_.StartsWith("data:") -and -not $_.Contains("[DONE]") })) {
  $j = $l.Substring(5).Trim() | ConvertFrom-Json
  if (-not $j.choices -or -not $j.choices.Count) { continue }
  $d = $j.choices[0].delta
  $d.PSObject.Properties | ForEach-Object { $keys[$_.Name] = $true }
  if ($d.content) { $content += $d.content }
}
"--- streaming ---"
"delta_keys    " + ($keys.Keys -join ", ")
"open=$($content.Contains('<think>')) close=$($content.Contains('</think>')) triple_nl=$($content.Contains("`n`n`n"))"
"json          " + (($content | ConvertTo-Json -Compress) -replace '^(.{0,300}).*$', '$1')
