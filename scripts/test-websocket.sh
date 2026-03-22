#!/bin/bash
# test-websocket.sh — Test the enriched WebSocket payload path
# Sends a mock WS_MESSAGE_INTERCEPTED trigger directly to the bridge server,
# bypassing the Chrome extension entirely. Useful for verifying backend
# handling of enriched payloads, deep-link generation, and identity cache.
#
# Usage: bash scripts/test-websocket.sh
# Requires: trigger-server.js running on localhost:3000

echo "Sending enriched WebSocket trigger to localhost:3000/trigger..."

RESPONSE=$(curl -s -X POST http://localhost:3000/trigger \
  -H "Content-Type: application/json" \
  -d '{
    "type": "WS_MESSAGE_INTERCEPTED",
    "senderName": "Test User",
    "senderId": "test-entra-id-123",
    "messageText": "Hello, this is a test message",
    "conversationId": "19:test-conversation-id@thread.v2",
    "model": "claude-sonnet-4-6"
  }')

echo "Response: ${RESPONSE}"
