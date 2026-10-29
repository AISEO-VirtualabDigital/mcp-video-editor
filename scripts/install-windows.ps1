<#
.SYNOPSIS
  Installs the mcp-video-editor MCP server on Windows and writes ready-to-use
  client config snippets for Cursor, Claude Desktop, Codex, Antigravity,
  OpenCode, and KiloCode.

.DESCRIPTION
  This script:
    1. Clones/copies the project to %USERPROFILE%\mcp-video-editor (if not already there)
    2. Runs `npm install` and `npm run build`
    3. Writes the per-client config files into each client's expected location,
       with the absolute path to dist/index.js filled in for this machine.
    4. Backs up any pre-existing config files to *.bak

  Run from the project root directory:
    pwsh -File scripts/install-windows.ps1

.PARAMETER SkipBuild
  Skip `npm install` and `npm run build` (use when already built).

.PARAMETER Clients
  Comma-separated list of clients to install for.
  Default: cursor,claude,codex,antigravity,opencode,kilo
  Qwen Code (qwen) and ZCode (zcode) are accepted but never written — their
  config files hold unrelated settings, so the script prints the merge target.
  Example: -Clients "cursor,claude"

.EXAMPLE
  pwsh -File scripts/install-windows.ps1
  pwsh -File scripts/install-windows.ps1 -Clients "cursor,claude,codex"
#>

[CmdletBinding()]
param(
  [switch]$SkipBuild,
  [string]$Clients = "cursor,claude,codex,antigravity,opencode,kilo"
)

$ErrorActionPreference = "Stop"

# Resolve the project root (parent of this script).
$ProjectRoot = Resolve-Path "$PSScriptRoot/.."
$DistIndex   = Join-Path $ProjectRoot "dist/index.js"

Write-Host "==> mcp-video-editor installer" -ForegroundColor Cyan
Write-Host "Project root: $ProjectRoot"
Write-Host "Server entry: $DistIndex"

# 1. Build if requested.
if (-not $SkipBuild) {
  Write-Host "`n==> Running npm install..." -ForegroundColor Cyan
  Push-Location $ProjectRoot
  try {
    npm install --silent
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
  } finally { Pop-Location }

  Write-Host "==> Running npm run build..." -ForegroundColor Cyan
  Push-Location $ProjectRoot
  try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
  } finally { Pop-Location }
}

if (-not (Test-Path $DistIndex)) {
  throw "Build output missing: $DistIndex. Run without -SkipBuild."
}

# 2. Prepare env values.
$UserName = $env:USERNAME
$BackupDir  = Join-Path $env:USERPROFILE ".mcp-video-editor\backups"
$ExportDir  = Join-Path $env:USERPROFILE "Videos\mcp-video-editor"
$OpencutDir = Join-Path $env:USERPROFILE "Documents\OpenCut\projects"

# 3. Make sure target dirs exist.
foreach ($d in @($BackupDir, $ExportDir, $OpencutDir)) {
  if (-not (Test-Path $d)) {
    New-Item -ItemType Directory -Path $d -Force | Out-Null
    Write-Host "Created dir: $d" -ForegroundColor DarkGray
  }
}

# 4. Define per-client install recipes.
$ClientRecipes = @{
  cursor = @{
    ConfigPath = Join-Path $env:USERPROFILE ".cursor\mcp.json"
    Template   = Join-Path $ProjectRoot "configs\cursor-mcp.json"
  }
  claude = @{
    ConfigPath = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"
    Template   = Join-Path $ProjectRoot "configs\claude-desktop-config.json"
  }
  codex = @{
    ConfigPath = Join-Path $env:USERPROFILE ".codex\config.toml"
    Template   = Join-Path $ProjectRoot "configs\codex-config.toml"
  }
  antigravity = @{
    ConfigPath = Join-Path $env:USERPROFILE ".gemini\config\mcp_config.json"
    Template   = Join-Path $ProjectRoot "configs\antigravity-mcp_config.json"
  }
  opencode = @{
    ConfigPath = Join-Path $env:USERPROFILE ".config\opencode\opencode.json"
    Template   = Join-Path $ProjectRoot "configs\opencode.json"
  }
  kilo = @{
    ConfigPath = Join-Path $env:USERPROFILE ".config\kilo\kilo.jsonc"
    Template   = Join-Path $ProjectRoot "configs\kilo-kilo.jsonc"
  }
}

# Clients whose config file also holds unrelated settings — never overwrite these.
$ManualRecipes = @{
  qwen = @{
    ConfigPath = Join-Path $env:USERPROFILE ".qwen\settings.json"
    Template   = Join-Path $ProjectRoot "configs\qwen-config.json"
  }
  zcode = @{
    ConfigPath = Join-Path $env:USERPROFILE ".zcode\cli\setting.json"
    Template   = Join-Path $ProjectRoot "configs\zcode-config.json"
  }
}

# 5. Token replacement: the configs use "YOUR_USERNAME" as a placeholder for
#    the current user's home directory.
$Selected = $Clients -split "," | ForEach-Object { $_.Trim().ToLower() } | Where-Object { $_ }

foreach ($client in $Selected) {
  if ($ManualRecipes.ContainsKey($client)) {
    $m = $ManualRecipes[$client]
    Write-Warning "Manual merge required for $client`: merge $($m.Template) into $($m.ConfigPath) (existing file holds other settings — not overwritten)."
    continue
  }
  if (-not $ClientRecipes.ContainsKey($client)) {
    Write-Warning "Unknown client: $client (skipping)"
    continue
  }
  $recipe = $ClientRecipes[$client]
  $template = $recipe.Template
  $destPath = $recipe.ConfigPath

  if (-not (Test-Path $template)) {
    Write-Warning "Template missing: $template (skipping $client)"
    continue
  }

  # Read template, substitute placeholders.
  $content = Get-Content $template -Raw
  # We replace YOUR_USERNAME (used in dist path + env paths) — using regex
  # against both forward and backward slashes since JSON allows both.
  $content = $content -replace "YOUR_USERNAME", $UserName

  # Back up existing file if present.
  if (Test-Path $destPath) {
    $bakPath = "$destPath.bak.$(Get-Date -Format yyyyMMddHHmmss)"
    Copy-Item $destPath $bakPath -Force
    Write-Host "Backed up existing $client config to $bakPath" -ForegroundColor Yellow
  } else {
    $destDir = Split-Path $destPath -Parent
    if (-not (Test-Path $destDir)) {
      New-Item -ItemType Directory -Path $destDir -Force | Out-Null
    }
  }

  # Special-case Codex TOML — we need to MERGE into existing config.toml if present.
  if ($client -eq "codex" -and (Test-Path $destPath)) {
    # Append our snippet (a TOML merge would require a TOML parser we don't bundle).
    # Warn the user and offer to overwrite vs. append.
    Write-Warning "Codex config.toml already exists at $destPath. Appending our snippet — please merge manually if you have other MCP servers defined."
    Add-Content -Path $destPath -Value "`n# --- mcp-video-editor (added $(Get-Date -Format o)) ---`n$content"
  } else {
    Set-Content -Path $destPath -Value $content -Encoding UTF8
  }
  Write-Host "Installed $client config -> $destPath" -ForegroundColor Green
}

# 6. Final verification: try to start the server briefly to confirm it boots.
Write-Host "`n==> Verifying server boots..." -ForegroundColor Cyan
$probe = Start-Process -FilePath "node" -ArgumentList @($DistIndex) -NoNewWindow -RedirectStandardError "$env:TEMP\mcp-probe.err" -RedirectStandardOutput "$env:TEMP\mcp-probe.out" -PassThru
Start-Sleep -Milliseconds 200
if (-not $probe.HasExited) {
  Stop-Process -Id $probe.Id -Force
  Write-Host "Server started cleanly (PID $($probe.Id), killed after probe)." -ForegroundColor Green
} else {
  $err = Get-Content "$env:TEMP\mcp-probe.err" -Raw
  Write-Error "Server failed to start:`n$err"
}

Write-Host "`n==> Done!" -ForegroundColor Cyan
Write-Host "Next steps:"
Write-Host "  1. Restart each AI client (Cursor, Claude Desktop, Codex, Antigravity, OpenCode, KiloCode)."
Write-Host "     Qwen Code and ZCode CLI were not written — merge their templates by hand (see docs/CLIENT_SETUP.md)."
Write-Host "  2. In each client, run a list_projects tool call to confirm connectivity."
Write-Host "  3. Open a CapCut or OpenCut project and try add_video_clip / add_text."
