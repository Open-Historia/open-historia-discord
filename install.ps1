# Open Historia - Discord edition one-click installer (Windows).
# Double-click install.bat (which runs this). It installs Node + dependencies +
# a headless Chromium, provisions the game, sets up a Cloudflare Tunnel for the
# read-only live map, writes discord.config.json (your secrets, gitignored) and
# start.bat, and registers the bot's slash commands.
$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

function Section($t) { Write-Host ""; Write-Host "==== $t ====" -ForegroundColor Cyan }
function Refresh-Path {
  $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
              [System.Environment]::GetEnvironmentVariable("Path","User")
}
function Have-Cmd($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }
function Winget-Install($id, $label) {
  if (-not (Have-Cmd "winget")) { return }
  Write-Host "Installing $label automatically (via winget)..." -ForegroundColor Cyan
  try { winget install --id $id -e --accept-source-agreements --accept-package-agreements } catch { }
  Refresh-Path
}
function NodeOk { try { return [int]((node --version).TrimStart("v").Split(".")[0]) -ge 18 } catch { return $false } }

Write-Host ""
Write-Host "==============================================" -ForegroundColor Cyan
Write-Host "  Open Historia - Discord edition setup" -ForegroundColor Cyan
Write-Host "  Host a vote-driven game on your own server." -ForegroundColor Cyan
Write-Host "==============================================" -ForegroundColor Cyan

# ---- Autofill from an existing config (re-runs never make you re-enter) ----
# Load the saved discord.config.json if present; every prompt then offers the
# saved value as its default, so pressing Enter keeps it. (PowerShell returns
# $null for a missing nested property, so these reads are safe when $existing is null.)
$existing = $null
$cfgFile = Join-Path $PSScriptRoot "discord.config.json"
if (Test-Path $cfgFile) {
  try { $existing = ((Get-Content $cfgFile -Raw) -replace "^\xEF\xBB\xBF", "") | ConvertFrom-Json } catch { $existing = $null }
  if ($existing) { Write-Host "Found your saved discord.config.json - press Enter at any prompt to keep the saved value." -ForegroundColor Green }
}
function Ask($label, $default) {
  $shown = if ($default) { "$label [$default]" } else { $label }
  $v = Read-Host $shown
  if ([string]::IsNullOrWhiteSpace($v)) { return $default } else { return $v }
}
function AskSecret($label, $current) {
  $shown = if ($current) { "$label [saved - Enter to keep]" } else { $label }
  $v = Read-Host $shown
  if ([string]::IsNullOrWhiteSpace($v)) { return $current } else { return $v }
}

# ---- 1. Prerequisites ----
Section "1/6  Checking prerequisites (Node.js, git)"
if (-not (NodeOk)) { Winget-Install "OpenJS.NodeJS.LTS" "Node.js LTS" }
if (-not (NodeOk)) {
  Write-Host "Couldn't install Node.js automatically." -ForegroundColor Red
  Start-Process "https://nodejs.org/en/download"; Read-Host "Install Node LTS, then re-run. Press Enter to exit"; exit 1
}
Write-Host "Node.js $(node --version) ready." -ForegroundColor Green
if (-not (Have-Cmd "git")) { Winget-Install "Git.Git" "Git" }
if (-not (Have-Cmd "git")) { Write-Host "git is required to fetch/build the game. Install from https://git-scm.com/downloads and re-run." -ForegroundColor Red; Read-Host "Press Enter to exit"; exit 1 }
Write-Host "git ready." -ForegroundColor Green

# ---- 2. Dependencies + headless browser ----
Section "2/6  Installing dependencies + headless Chromium"
Push-Location (Join-Path $PSScriptRoot "app")
npm install
$installOk = $LASTEXITCODE -eq 0
if ($installOk) { npx playwright install chromium; $installOk = $LASTEXITCODE -eq 0 }
Pop-Location
if (-not $installOk) { Read-Host "Dependency install failed. Press Enter to exit"; exit 1 }

# ---- 3. The game (submodule build, or an existing path) ----
Section "3/6  The game"
$gameDir = ""
# Re-run shortcut: reuse an already-built game instead of rebuilding.
if ($existing -and $existing.gameDir -and (Test-Path (Join-Path $existing.gameDir "dist"))) {
  $keep = Ask "Reuse the built game at $($existing.gameDir)? (y/n)" "y"
  if ($keep -match "^[Yy]") { $gameDir = $existing.gameDir; Write-Host "Reusing existing build." -ForegroundColor Green }
}
$sub = Join-Path $PSScriptRoot "game"
if (-not $gameDir) {
  if (Test-Path (Join-Path $sub "server\server.js")) {
    Write-Host "Found the bundled game submodule; building it..." -ForegroundColor Cyan
    Push-Location $sub; git submodule update --init --recursive 2>$null; npm ci; npm run build; Pop-Location
    $gameDir = (Resolve-Path $sub).Path
  } else {
    $mode = Read-Host "Game: (1) clone & build the discord-edition fork  (2) use an existing built path [1]"
    if ($mode -eq "2") {
      $gameDir = Read-Host "Path to a built game (folder containing server\ and dist\)"
    } else {
      git clone -b discord-edition https://github.com/Open-Historia/open-historia-discord-game game
      Push-Location game; npm ci; npm run build; Pop-Location
      $gameDir = (Resolve-Path game).Path
    }
  }
}
Write-Host "Game: $gameDir" -ForegroundColor Green

# ---- 4. Discord bot ----
Section "4/6  Discord bot"
Write-Host "Create an app + bot at https://discord.com/developers/applications,"
Write-Host "enable no privileged intents (this edition needs none), invite it with Manage Roles"
Write-Host "+ Manage Channels, then paste its ids below."
$dToken  = AskSecret "Discord bot token" $existing.discord.token
$dClient = Ask "Application (client) id" $existing.discord.clientId
$dGuild  = Ask "Server (guild) id" $existing.discord.guildId
$dChannel = Ask "Channel id for game posts (optional)" $existing.discord.channelId

# ---- 5. AI provider (drives the game's simulation) ----
Section "5/6  AI provider"
$providers = @("gemini","openai","anthropic","openai-compatible","anthropic-compatible")
$defAi = if ($existing) { $existing.ai.provider } else { "" }
for ($i=0; $i -lt $providers.Count; $i++) { Write-Host ("  {0}) {1}" -f ($i+1), $providers[$i]) }
$ai = ""
$prompt5 = if ($defAi) { "Choose 1-$($providers.Count) [keep $defAi]" } else { "Choose 1-$($providers.Count)" }
do {
  $p = Read-Host $prompt5
  if ([string]::IsNullOrWhiteSpace($p) -and $defAi) { $ai = $defAi }
  else { $pn = 0; if ([int]::TryParse($p,[ref]$pn) -and $pn -ge 1 -and $pn -le $providers.Count) { $ai = $providers[$pn-1] } }
} while (-not $ai)
$aiKey = AskSecret "AI API key" $existing.ai.apiKey
$aiModel = Ask "Model (Enter for the provider default)" $existing.ai.model
$aiEndpoint = ""
if ($ai -like "*-compatible") { $aiEndpoint = Ask "Endpoint URL" $existing.ai.endpoint }

# ---- 6. Ports + tunnel (the read-only live map) ----
Section "6/6  Ports + Cloudflare Tunnel"
$gamePort = Ask "Game port (loopback only)" $(if ($existing.gamePort) { $existing.gamePort } else { "3000" })
$spectatorPort = Ask "Public spectator port" $(if ($existing.spectatorPort) { $existing.spectatorPort } else { "8080" })
$bridgePort = Ask "Bridge RPC port (loopback only)" $(if ($existing.bridgePort) { $existing.bridgePort } else { "8090" })
$tunnelMode = "none"; $tunnelName = ""; $publicUrl = ""
$defTunnelYN = if ($existing -and $existing.tunnel -eq "none") { "n" } else { "Y" }
$useTunnel = Ask "Set up a Cloudflare Tunnel for the live map now? [Y/n]" $defTunnelYN
if ($useTunnel -notmatch "^[Nn]") {
  $cf = Join-Path $PSScriptRoot "app\cloudflared.exe"
  if (-not (Test-Path $cf)) {
    Write-Host "Downloading cloudflared..." -ForegroundColor Cyan
    $arch = if ([Environment]::Is64BitOperatingSystem) { "amd64" } else { "386" }
    Invoke-WebRequest "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-$arch.exe" -OutFile $cf
  }
  $kind = Read-Host "Tunnel: 1) quick (instant, URL rotates)  2) named (permanent, needs a domain) [1]"
  if ($kind -eq "2") {
    & $cf tunnel login
    $tname = Read-Host "Name for this tunnel [oh-discord]"; if ([string]::IsNullOrWhiteSpace($tname)) { $tname = "oh-discord" }
    & $cf tunnel create $tname
    $host1 = Read-Host "Hostname (subdomain of your Cloudflare domain)"
    & $cf tunnel route dns $tname $host1
    $publicUrl = "https://$host1"; $tunnelMode = "named"; $tunnelName = $tname
  } else { $tunnelMode = "quick" }
}

# ---- Write config (BOM-free) + start.bat + register commands ----
$config = [ordered]@{
  discord = [ordered]@{ token=$dToken; clientId=$dClient; guildId=$dGuild; channelId=$dChannel }
  ai = [ordered]@{ provider=$ai; apiKey=$aiKey; model=$aiModel; endpoint=$aiEndpoint }
  gameDir = $gameDir
  gamePort = [int]$gamePort; spectatorPort = [int]$spectatorPort; bridgePort = [int]$bridgePort
  tunnel = $tunnelMode; tunnelName = $tunnelName; publicUrl = $publicUrl
}
# UTF-8 WITHOUT a BOM (PowerShell 5.1 '-Encoding UTF8' adds a BOM JSON.parse rejects).
[System.IO.File]::WriteAllText((Join-Path $PSScriptRoot "discord.config.json"), ($config | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
$startBat = @"
@echo off
cd /d "%~dp0"
node app\run.mjs
pause
"@
Set-Content -Path (Join-Path $PSScriptRoot "start.bat") -Value $startBat -Encoding ASCII

Write-Host ""
Write-Host "Registering slash commands..." -ForegroundColor Cyan
Push-Location (Join-Path $PSScriptRoot "app"); node bot.mjs --register-only; Pop-Location

Write-Host ""
Write-Host "================= Setup complete! =================" -ForegroundColor Green
Write-Host "  Start any time: double-click start.bat."
Write-Host "  In your server: /startgame nation:France  then  /propose ... /openvote"
Write-Host "  Your Discord token + AI key live only in discord.config.json (gitignored)."
Write-Host "==================================================="
$startNow = Read-Host "Start now? (y/N)"
if ($startNow -match "^[Yy]") { $bat = Join-Path $PSScriptRoot "start.bat"; Start-Process "cmd.exe" -ArgumentList "/c", "`"$bat`"" }
