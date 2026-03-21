#!/bin/bash
# extension-installer.sh
# Validates the extension directory and guides the user through loading it in Chrome.

set -e

EXTENSION_DIR="$(cd "$(dirname "$0")/../extension" && pwd)"

echo "=== Son of Claude — Extension Installer ==="
echo ""

# Validate required files exist
REQUIRED_FILES=("manifest.json" "background.js" "content.js")
ALL_PRESENT=true

for file in "${REQUIRED_FILES[@]}"; do
  if [ -f "$EXTENSION_DIR/$file" ]; then
    echo "  ✅ $file found"
  else
    echo "  ❌ $file MISSING"
    ALL_PRESENT=false
  fi
done

echo ""

if [ "$ALL_PRESENT" = false ]; then
  echo "ERROR: One or more required extension files are missing."
  echo "Run this script from the repo root after completing Phase 1."
  exit 1
fi

echo "All extension files present."
echo ""
echo "=== Manual Installation Steps ==="
echo ""
echo "1. Open Chrome and navigate to: chrome://extensions"
echo "2. Enable 'Developer mode' (toggle in the top-right corner)"
echo "3. Click 'Load unpacked'"
echo "4. Select this directory: $EXTENSION_DIR"
echo "5. The 'Son of Claude Watcher' extension should appear in the list"
echo ""
echo "=== Verification ==="
echo ""
echo "1. Navigate to https://teams.microsoft.com in Chrome"
echo "2. Open the extension's background service worker console:"
echo "   chrome://extensions -> Son of Claude Watcher -> 'Inspect views: service worker'"
echo "3. Confirm 'Son of Claude: Activity message received...' appears when a message arrives"
echo ""
echo "=== Next Step ==="
echo "Run Phase 2 to connect the extension to the local trigger-server bridge."
