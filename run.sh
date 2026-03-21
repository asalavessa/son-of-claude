#!/bin/bash

# If "once" is passed, run Claude a single time and exit.
# Used by trigger-server.js (event-driven mode).
if [ "$1" == "once" ]; then
  MODEL="${2:-claude-sonnet-4-6}"
  echo "[$(date)] Event-driven run triggered. Model: ${MODEL}"
  claude -p "You are an automated agent executing a single-pass task. Read BRAIN.md now. Execute every step in the Run Checklist section using your tools. After step 6, stop immediately — do not re-check, do not verify, do not loop. Start by reading BRAIN.md." --chrome --model "${MODEL}" --allowedTools "mcp__claude-in-chrome*"
  echo "[$(date)] Event-driven run complete."
  exit 0
fi

# Default: polling loop (legacy mode)
INTERVAL="${1:-120}"

echo "=== son-of-claude ==="
echo "Interval: ${INTERVAL}s"
echo "Press Ctrl+C to stop"
echo

while true; do
  echo "[$(date)] Checking Teams..."

  claude -p "You are an automated agent executing a single-pass task. Read BRAIN.md now. Execute every step in the Run Checklist section using your tools. After step 6, stop immediately — do not re-check, do not verify, do not loop. Start by reading BRAIN.md." --chrome --model sonnet --allowedTools "mcp__claude-in-chrome*"

  echo "[$(date)] Done. Sleeping ${INTERVAL}s..."
  echo "---"
  sleep "$INTERVAL"
done
