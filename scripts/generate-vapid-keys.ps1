# Maakt een VAPID-sleutelpaar (P-256) voor web push, zonder Node. Schrijft VAPID_PUBLIC_KEY en
# VAPID_PRIVATE_KEY naar .env.local en toont ALLEEN de publieke sleutel.
#   powershell -ExecutionPolicy Bypass -File scripts\generate-vapid-keys.ps1
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root ".env.local"

function To-B64Url([byte[]]$b) { [Convert]::ToBase64String($b).TrimEnd("=").Replace("+", "-").Replace("/", "_") }
function Pad32([byte[]]$b) { if ($b.Length -ge 32) { return $b } ; return [byte[]](@(0) * (32 - $b.Length)) + $b }

$ec = [System.Security.Cryptography.ECDsa]::Create([System.Security.Cryptography.ECCurve+NamedCurves]::nistP256)
$p = $ec.ExportParameters($true)
$public = To-B64Url ([byte[]](@(4) + (Pad32 $p.Q.X) + (Pad32 $p.Q.Y)))   # 65 bytes, ongecomprimeerd punt
$private = To-B64Url (Pad32 $p.D)                                        # 32 bytes

$lines = @()
if (Test-Path $envFile) { $lines = @(Get-Content $envFile | Where-Object { $_ -notmatch '^\s*VAPID_(PUBLIC|PRIVATE)_KEY\s*=' }) }
$lines += "VAPID_PUBLIC_KEY=$public"
$lines += "VAPID_PRIVATE_KEY=$private"
[IO.File]::WriteAllLines($envFile, [string[]]$lines, (New-Object Text.UTF8Encoding $false))

"VAPID-sleutels geschreven naar .env.local"
"VAPID_PUBLIC_KEY=$public"
"(VAPID_PRIVATE_KEY staat alleen in .env.local; kopieer hem zelf naar Vercel)"
