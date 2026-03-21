#!/bin/bash

# SESSION MODE: keep-alive loop for active conversations.
# Used by trigger-server.js. Runs an initial pass, then polls for follow-ups
# until SESSION_DURATION expires or no new message is detected.
if [ "$1" == "session" ]; then
  MODEL="${2:-claude-sonnet-4-6}"
  SESSION_DURATION="${SESSION_DURATION:-120}"  # Override with: export SESSION_DURATION=300

  echo "[$(date)] Starting Conversation Session. Model: ${MODEL}, Window: ${SESSION_DURATION}s"

  # Initial pass: handle the triggering message
  claude -p "You are an automated agent starting a conversation session. Read BRAIN.md now. Execute the Initial Pass checklist. Start by reading BRAIN.md." \
    --chrome --model "${MODEL}" --allowedTools "mcp__claude-in-chrome*"

  # Timer starts AFTER the first reply is sent
  END_TIME=$(( $(date +%s) + SESSION_DURATION ))
  echo "[$(date)] First reply sent. Session window open for ${SESSION_DURATION}s."

  # Follow-up loop: poll the same conversation until the session window expires
  while [ "$(date +%s)" -lt "$END_TIME" ]; do
    REMAINING=$(( END_TIME - $(date +%s) ))
    echo "[$(date)] Polling for follow-ups... (${REMAINING}s remaining in session)"

    RESULT=$(claude --continue -p "You are in Session Mode. Execute the Session Follow-up checklist in BRAIN.md. If there is no new message to reply to, output exactly the word: NO_NEW_MSG" \
      --chrome --model "${MODEL}" --allowedTools "mcp__claude-in-chrome*" 2>&1)

    if echo "$RESULT" | grep -q "NO_NEW_MSG"; then
      echo "[$(date)] No follow-up detected. Waiting 10s before next check..."
      sleep 10
    else
      echo "[$(date)] Follow-up handled. Extending session window."
      END_TIME=$(( $(date +%s) + SESSION_DURATION ))
    fi
  done

  echo "[$(date)] Session window expired. Exiting."
  exit 0
fi

# ONCE MODE: single pass, used for direct invocation or testing.
if [ "$1" == "once" ]; then
  MODEL="${2:-claude-sonnet-4-6}"
  echo "[$(date)] Event-driven run triggered. Model: ${MODEL}"
  claude -p "You are an automated agent executing a single-pass task. Read BRAIN.md now. Execute every step in the Run Checklist section using your tools. After step 6, stop immediately — do not re-check, do not verify, do not loop. Start by reading BRAIN.md." \
    --chrome --model "${MODEL}" --allowedTools "mcp__claude-in-chrome*"
  echo "[$(date)] Event-driven run complete."
  exit 0
fi

# POLLING MODE: legacy interval loop.
INTERVAL="${1:-120}"

echo "=== son-of-claude ==="
echo "Interval: ${INTERVAL}s"
echo "Press Ctrl+C to stop"
echo

while true; do
  echo "[$(date)] Checking Teams..."

  claude -p "You are an automated agent executing a single-pass task. Read BRAIN.md now. Execute every step in the Run Checklist section using your tools. After step 6, stop immediately — do not re-check, do not verify, do not loop. Start by reading BRAIN.md." \
    --chrome --model sonnet --allowedTools "mcp__claude-in-chrome*"

  echo "[$(date)] Done. Sleeping ${INTERVAL}s..."
  echo "---"
  sleep "$INTERVAL"
done
