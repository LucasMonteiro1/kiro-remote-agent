#!/usr/bin/env bash
# Builds a .vsix package for this extension and installs it into Kiro IDE
# via the official `kiro --install-extension` CLI (same mechanism used by
# Extensions: Install from VSIX... in the UI). This is the exact same
# artifact any other dev would download and install — nothing about the
# install path is specific to this machine.
#
# Usage: ./install-local.sh
set -euo pipefail

cd "$(dirname "$0")"

echo "Building extension bundle..."
yarn build

echo "Packaging .vsix..."
rm -f kiro-remote-bridge-*.vsix
npx --yes @vscode/vsce package --no-yarn --skip-license

VSIX_FILE=$(ls kiro-remote-bridge-*.vsix | head -1)

echo "Installing $VSIX_FILE into Kiro..."
if command -v kiro >/dev/null 2>&1; then
  kiro --install-extension "$VSIX_FILE"
else
  echo "Kiro CLI ('kiro') not found on PATH."
  echo "Install manually: open Kiro -> Extensions -> ... -> Install from VSIX... -> select $VSIX_FILE"
  exit 1
fi

echo "Done. Reload the Kiro IDE window (Cmd+Shift+P -> Developer: Reload Window) to pick up the update."
