#!/usr/bin/env bash
#
# Cross-platform fallback installer for mcp-video-editor.
# Prefer scripts/install-windows.ps1 on Windows; use this on macOS/Linux
# (or when you don't have PowerShell available).
#
# Usage:
#   bash scripts/install-unix.sh                # install for all clients
#   bash scripts/install-unix.sh --skip-build   # skip npm install + build
#   bash scripts/install-unix.sh --clients cursor,claude
#
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_INDEX="$PROJECT_ROOT/dist/index.js"

SKIP_BUILD=false
CLIENTS="cursor,claude,codex,antigravity,opencode,kilo"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-build) SKIP_BUILD=true; shift ;;
    --clients)    CLIENTS="$2"; shift 2 ;;
    *) echo "Unknown arg: $1" >&2; exit 1 ;;
  esac
done

echo "==> mcp-video-editor installer (unix)"
echo "Project root: $PROJECT_ROOT"
echo "Server entry: $DIST_INDEX"

# Detect OS for path conventions.
case "$(uname -s)" in
  Darwin*) OS="macos"; USER_HOME="${HOME}"; CONFIG_HOME="${HOME}/.config" ;;
  Linux*)  OS="linux"; USER_HOME="${HOME}"; CONFIG_HOME="${HOME}/.config" ;;
  MINGW*|MSYS*|CYGWIN*) OS="windows"; USER_HOME="${USERPROFILE:-${HOME}}"; CONFIG_HOME="${APPDATA:-${HOME}/AppData/Roaming}" ;;
  *) echo "Unknown OS: $(uname -s)" >&2; exit 1 ;;
esac

# 1. Build if requested.
if [[ "$SKIP_BUILD" == "false" ]]; then
  echo ""
  echo "==> npm install"
  (cd "$PROJECT_ROOT" && npm install --silent)
  echo "==> npm run build"
  (cd "$PROJECT_ROOT" && npm run build)
fi
[[ -f "$DIST_INDEX" ]] || { echo "Build output missing: $DIST_INDEX" >&2; exit 1; }

# 2. Prepare dirs.
BACKUP_DIR="$USER_HOME/.mcp-video-editor/backups"
EXPORT_DIR="$USER_HOME/Videos/mcp-video-editor"
OPENCUT_DIR="$USER_HOME/Documents/OpenCut/projects"
for d in "$BACKUP_DIR" "$EXPORT_DIR" "$OPENCUT_DIR"; do
  mkdir -p "$d"
  echo "Created dir: $d"
done

# 3. Resolve each client's config path.
declare -A CONFIG_PATHS
CONFIG_PATHS[cursor]="$USER_HOME/.cursor/mcp.json"
CONFIG_PATHS[claude]="$CONFIG_HOME/Claude/claude_desktop_config.json"
CONFIG_PATHS[codex]="$USER_HOME/.codex/config.toml"
CONFIG_PATHS[antigravity]="$USER_HOME/.gemini/config/mcp_config.json"
CONFIG_PATHS[opencode]="$CONFIG_HOME/opencode/opencode.json"
CONFIG_PATHS[kilo]="$CONFIG_HOME/kilo/kilo.jsonc"

# Clients whose config file also holds unrelated settings — never overwrite these.
declare -A MANUAL_PATHS
MANUAL_PATHS[qwen]="$USER_HOME/.qwen/settings.json"
MANUAL_PATHS[zcode]="$USER_HOME/.zcode/cli/setting.json"

declare -A TEMPLATE_PATHS
TEMPLATE_PATHS[cursor]="$PROJECT_ROOT/configs/cursor-mcp.json"
TEMPLATE_PATHS[claude]="$PROJECT_ROOT/configs/claude-desktop-config.json"
TEMPLATE_PATHS[codex]="$PROJECT_ROOT/configs/codex-config.toml"
TEMPLATE_PATHS[antigravity]="$PROJECT_ROOT/configs/antigravity-mcp_config.json"
TEMPLATE_PATHS[opencode]="$PROJECT_ROOT/configs/opencode.json"
TEMPLATE_PATHS[kilo]="$PROJECT_ROOT/configs/kilo-kilo.jsonc"

USER_NAME="$(whoami)"

IFS=',' read -ra client_list <<< "$CLIENTS"
for client in "${client_list[@]}"; do
  client=$(echo "$client" | xargs) # trim
  [[ -z "$client" ]] && continue

  tmpl="${TEMPLATE_PATHS[$client]:-}"
  dest="${CONFIG_PATHS[$client]:-}"

  if [[ -n "${MANUAL_PATHS[$client]:-}" ]]; then
    echo "Manual merge required for $client: merge $(basename "$PROJECT_ROOT")/configs/$client-config.json into ${MANUAL_PATHS[$client]}"
    continue
  fi

  if [[ -z "$tmpl" || -z "$dest" ]]; then
    echo "Unknown client: $client (skipping)" >&2
    continue
  fi
  [[ -f "$tmpl" ]] || { echo "Template missing: $tmpl (skipping $client)" >&2; continue; }

  # Read template and substitute YOUR_USERNAME.
  content=$(sed "s|YOUR_USERNAME|$USER_NAME|g" "$tmpl")

  # Backup existing file.
  if [[ -f "$dest" ]]; then
    bak="${dest}.bak.$(date +%Y%m%d%H%M%S)"
    cp "$dest" "$bak"
    echo "Backed up existing $client config -> $bak"
  else
    mkdir -p "$(dirname "$dest")"
  fi

  if [[ "$client" == "codex" && -f "$dest" ]]; then
    echo "" >> "$dest"
    echo "# --- mcp-video-editor (added $(date -Iseconds)) ---" >> "$dest"
    echo "$content" >> "$dest"
    echo "Appended $client config (merge manually if other servers present)"
  else
    printf '%s\n' "$content" > "$dest"
    echo "Installed $client config -> $dest"
  fi
done

# 4. Final verification: ensure the server boots cleanly.
echo ""
echo "==> Verifying server boots..."
if echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"install-probe","version":"0.0.0"}}}' \
   | timeout 3 node "$DIST_INDEX" 2>/dev/null | grep -q '"serverInfo"'; then
  echo "Server started cleanly."
else
  echo "WARNING: server probe failed. Check dist/index.js exists and node version >= 18." >&2
fi

echo ""
echo "==> Done!"
echo "Next steps:"
echo "  1. Restart each AI client (Cursor, Claude Desktop, Codex, Antigravity, OpenCode, KiloCode)."
echo "     Qwen Code and ZCode CLI were not written — merge their templates by hand (see docs/CLIENT_SETUP.md)."
echo "  2. In each client, call list_projects with editor=capcut to verify."
echo "  3. Open a CapCut or OpenCut project and try add_video_clip / add_text."
