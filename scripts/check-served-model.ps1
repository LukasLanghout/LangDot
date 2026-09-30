# Vraagt elk model uit GET /models één keer aan en toont welk model het antwoord werkelijk gaf.
# Leest .env.local; print de key nooit.
$root = Split-Path -Parent $PSScriptRoot
$vars = @{}
foreach ($line in Get-Content (Join-Path $root ".env.local")) {
  if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$') { $vars[$matches[1]] = $matches[2].Trim() }
}
$base = $vars["GONKA_BASE_URL"].TrimEnd("/")
$headers = @{ Authorization = "Bearer $($vars["GONKA_API_KEY"])"; "Content-Type" = "application/json" }
$ids = (Invoke-RestMethod -UseBasicParsing -Uri "$base/models" -Headers $headers -TimeoutSec 30).data | ForEach-Object { $_.id }
foreach ($id in $ids) {
  foreach ($n in 1..2) {
    try {
      $body = @{ model = $id; messages = @(@{ role = "user"; content = "Zeg alleen: ok" }); max_tokens = 200 } | ConvertTo-Json -Depth 5 -Compress
      $r = Invoke-RestMethod -UseBasicParsing -Method Post -Uri "$base/chat/completions" -Headers $headers -Body ([Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 90
      "{0,-38} -> {1}" -f $id, $r.model
    } catch { "{0,-38} -> FOUT {1}" -f $id, $_.Exception.Message }
  }
}
