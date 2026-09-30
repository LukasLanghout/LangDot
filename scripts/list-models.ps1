# Toont de modellen die GonkaRouter meldt (GET /models). Leest .env.local; print de key nooit.
$root = Split-Path -Parent $PSScriptRoot
$vars = @{}
foreach ($line in Get-Content (Join-Path $root ".env.local")) {
  if ($line -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$') { $vars[$matches[1]] = $matches[2].Trim() }
}
$base = $vars["GONKA_BASE_URL"].TrimEnd("/")
$r = Invoke-RestMethod -UseBasicParsing -Uri "$base/models" -Headers @{ Authorization = "Bearer $($vars["GONKA_API_KEY"])" } -TimeoutSec 30
$r.data | ForEach-Object { $_ | ConvertTo-Json -Compress -Depth 5 }
