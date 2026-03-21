#!/bin/bash
# test-trigger.sh
# Manually fires a test trigger against the bridge server to verify end-to-end connectivity.
# The bridge server (trigger-server.js) must be running before executing this script.

BRIDGE_URL="http://127.0.0.1:3000/trigger"

echo "=== Son of Claude — Trigger Test ==="
echo ""
echo "Sending test trigger to: $BRIDGE_URL"
echo ""

RESPONSE=$(curl -s -o /tmp/soc-trigger-response.json -w "%{http_code}" \
  -X POST "$BRIDGE_URL" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"ACTIVITY_DETECTED\",\"timestamp\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"source\":\"test-trigger.sh\"}")

echo "HTTP Status: $RESPONSE"
echo "Response body:"
cat /tmp/soc-trigger-response.json
echo ""

if [ "$RESPONSE" == "200" ]; then
  echo "✅ Trigger accepted — check trigger-server.js output to confirm Claude launched."
elif [ "$RESPONSE" == "429" ]; then
  echo "⚠️  Trigger throttled — server is already processing or in cooldown. Wait 30s and retry."
elif [ "$RESPONSE" == "000" ]; then
  echo "❌ Connection refused — is trigger-server.js running? Start it with: node trigger-server.js"
else
  echo "❌ Unexpected status. Check trigger-server.js logs."
fi
