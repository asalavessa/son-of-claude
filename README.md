# Son of Claude (Based of https://github.com/asarnaout/son-of-claude)

A browser-automation agent that monitors Microsoft Teams and responds to messages on your behalf — no Graph API, no webhooks, no admin permissions required. Uses your existing Chrome session.

---

## Check DOCUMENTATION.MD for "Known Limitations" and Roadmap
---


## How It Works

When a new Teams message arrives, a Chrome extension intercepts the raw WebSocket (SignalR) frame to extract the exact sender name, message text, and conversation ID — before the UI even updates. The data is relayed to a local Node.js bridge, which queues the trigger and spawns Claude Code as soon as the agent is free. Claude navigates directly to the conversation (via deep-link for private chats), reads all unread messages, and responds. Messages are never dropped when Claude is busy — they wait in a FIFO queue. After the first reply, the session stays open for a configurable window (default: 5 minutes) and polls for follow-ups before exiting.

A legacy fallback path (tab title monitoring) runs in parallel and activates automatically if the WebSocket interception fails.

```
PRIMARY PATH — WebSocket Interception:
  Teams receives a SignalR WebSocket frame
    → interceptor.js (MAIN world) parses SignalR JSON, extracts sender + text
      → bridge.js (ISOLATED world) relays via chrome.runtime.sendMessage
        → background.js batches messages (3s window), applies sender filters
          → POSTs enriched payload to local bridge (127.0.0.1:3000)
            → Bridge deduplicates, queues task → 202 Accepted
              → processQueue() spawns: bash run.sh session <model> <url> <sender> <text>
                → Claude navigates directly, responds to ALL unread messages
                  → Session loop polls for follow-ups
                    → Loop exits after SESSION_DURATION seconds
                      → Cooldown (10s) → processQueue() drains next queued task

FALLBACK PATH — Tab Title Monitoring:
  Teams tab title changes to "(N) Chat | Name"
    → background.js detects unread count increase
      → POSTs to bridge → queued → spawns Claude (without pre-loaded text)
```

Personality and tone come from `SOUL.md`. Operational rules — who to respond to, what to avoid, how to navigate Teams — live in `BRAIN.md`.

---

## Requirements

- [Claude Code CLI](https://claude.ai/code) — authenticated and available in `$PATH`
- [Claude browser connector extension](https://code.claude.com/docs/en/chrome) — installed in Chrome
- Node.js 18+
- Google Chrome 111+
- A paid Anthropic plan (Pro, Max, Teams, or Enterprise)

---

## Installation

### 1. Install the Claude browser connector

This is the **official Claude extension** (not the Son of Claude Watcher). Install it from the Chrome Web Store. After installing, click its icon in Chrome and confirm it shows as connected.

### 2. Authenticate the Claude CLI

```bash
claude auth login
```

Follow the prompts. Verify it works:

```bash
claude -p "Say hello." --model claude-haiku-4-5-20251001
```

### 3. Load the Son of Claude Watcher extension

This is the **custom extension** in this repo that monitors Teams.

```bash
bash scripts/extension-installer.sh
```

Then in Chrome:
1. Go to `chrome://extensions`
2. Enable **Developer Mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder from this repo
5. Confirm "Son of Claude Watcher" appears in the list

### 4. Configure BRAIN.md and SOUL.md

Open `BRAIN.md` and fill in:

- **Do Not Respond List** — people Claude must never reply to (your boss, automated bots, etc.)
- **Respond List** — if you want to restrict replies to specific people only; leave the placeholder to reply to all
- **Allowed Websites** — additional URLs Claude is permitted to visit (e.g. your GitHub)

Open `SOUL.md` and fill in:

- **About the User** — your role and communication style
- **Per-Person Notes** — how to communicate with specific contacts

---

## Running

### Step 1 — Start the bridge server

Open a terminal and run:

```bash
node trigger-server.js
```

Leave this running. You should see:

```
Son of Claude Bridge running at http://127.0.0.1:3000
Listening for triggers from the Chrome extension...
```

### Step 2 — Open Teams in Chrome

Navigate to `https://teams.cloud.microsoft` in the same Chrome instance where both extensions are installed. Sign in if prompted. The Son of Claude Watcher extension activates automatically on this URL.

The Teams tab can stay in the background — it does not need to be the active tab.

### Step 3 — Configure the extension popup

Click the Son of Claude Watcher icon in Chrome:

| Setting | Recommendation |
|---------|----------------|
| Toggle | Must be **green (Active)** |
| Model | Start with **Sonnet** (reliable). Switch to Haiku to reduce cost, Opus for complex conversations. |
| Never reply to | Add bot names, notification accounts, anyone who should never get a reply |
| Only reply to | Leave empty to reply to all, or add specific names to restrict |

Click **Save** after changing the model or filter lists. The toggle takes effect instantly.

### Step 4 — Verify end-to-end

In a separate terminal, test the enriched WebSocket payload path:

```bash
bash scripts/test-websocket.sh
```

Or test the legacy path:

```bash
bash scripts/test-trigger.sh
```

Expected output for either:
```
{"status":"session_started","timestamp":"..."}
```

In the bridge terminal you should see Claude spawning and running.

### Step 5 — Test with a real message

Have someone (or yourself from another device) send a message in Teams. Within a few seconds you should see in the bridge terminal:

```
[timestamp] Activity detected. Sender: John Doe, Model: claude-sonnet-4-6
[timestamp] Message text (1 msgs): Hello, how are you?
[timestamp] Starting session...
```

Check the service worker console (`chrome://extensions` → Son of Claude Watcher → "Inspect views: service worker") for:
```
Son of Claude [ws]: Received intercepted message from John Doe
Son of Claude [ws]: Flushing batch of 1 message(s) to bridge server...
Son of Claude [ws]: Session started
```

---

## Extension Popup Reference

| Control | Details |
|---------|---------|
| **Toggle** | Pauses/resumes detection without stopping the bridge. Green = active, Red = paused. |
| **Model — Haiku** | Fastest and cheapest. Good for simple short replies. |
| **Model — Sonnet** | Default. Best balance of capability and cost. |
| **Model — Opus** | Most capable. Use for technical or nuanced conversations. |
| **Never reply to** | One name per line. Case-insensitive. Applied before Claude runs. |
| **Only reply to** | One name per line. Empty = no restriction. Applied before Claude runs. |
| **Save** | Persists model and filter lists. Toggle saves automatically. |

> **Note:** The WebSocket interception path extracts the exact sender name from SignalR frames — reliable and DOM-independent. The legacy tab-title path still relies on DOM scraping and may return `null`. In both cases, `BRAIN.md`'s Do Not Respond List is the authoritative safety gate.

---

## Identity Cache

When the WebSocket interceptor captures a sender's Entra ID but the display name is unavailable, the bridge server checks a local identity cache (`identity-cache.json`). If the ID is not mapped, the extension shows an OS notification with the unknown ID.

**Admin UI:** Visit `http://localhost:3000/identities` while the bridge is running to view, add, edit, or delete Entra ID → display name mappings.

---

## Reloading After Changes

| What you changed | What to do |
|------------------|-----------|
| `extension/*.js` or `extension/manifest.json` | `chrome://extensions` → Son of Claude Watcher → ↺ Reload, then refresh the Teams tab |
| `BRAIN.md` or `SOUL.md` | No restart needed — Claude reads them fresh each invocation |
| `trigger-server.js` or `identity-cache.json` | Stop bridge (`Ctrl+C`), restart with `node trigger-server.js` |
| `run.sh` | No restart needed — bridge re-reads it on each spawn |
| Extension popup settings | Saved automatically — no restart needed |

---

## Stopping

To stop the agent:

1. Click the extension popup and hit the toggle (turns red — paused). This stops new triggers immediately.
2. If a session is active, it will run until `SESSION_DURATION` expires (default: 120s from the last reply) before exiting. The bridge enforces a 10-minute hard kill as a safety net.
3. Stop the bridge: `Ctrl+C` in the bridge terminal.

To shorten or extend the session window:
```bash
export SESSION_DURATION=60   # 1-minute session window
node trigger-server.js
```

---

## Legacy Polling Mode

The original polling loop is still available if you prefer it over the event-driven setup:

```bash
# Check Teams every 120 seconds (default)
./run.sh

# Custom interval — e.g. every 5 minutes
./run.sh 300
```

Polling mode does not require the extension or bridge to be running. It is less token-efficient (Claude runs every N seconds regardless of activity) but simpler to operate.

Windows: `run.bat` or `run.bat 300`.

---

## Troubleshooting

**"Chrome extension not connected"**
The Claude browser connector extension is not active. Click its icon in Chrome and check the connection status. Make sure you're using the same Chrome instance that has the extension installed.

**Bridge terminal shows nothing when a message arrives**
- Confirm the Son of Claude Watcher popup is green (active)
- Check the service worker console: `chrome://extensions` → Son of Claude Watcher → "Inspect views: service worker"
- Confirm the Teams URL contains `teams.cloud.microsoft` or `teams.microsoft.com`
- Run `bash scripts/test-trigger.sh` to verify the bridge is reachable

**"Failed to fetch" in service worker console**
Make sure the bridge is running (`node trigger-server.js`). The extension POSTs to `127.0.0.1:3000` — if the bridge is not running, the fetch will fail.

**Claude runs but doesn't reply**
Check Claude's output in the bridge terminal. Common causes:
- Teams compose box interaction failed — try `Ctrl+Shift+X` manually in Teams to confirm it works
- The sender is on the Do Not Respond List in `BRAIN.md`
- Teams showed an error banner during send — Claude will retry once, then exit

**Claude keeps running and doesn't exit**
This is expected behavior during an active session. The session loop polls for follow-ups for `SESSION_DURATION` seconds (default: 120) after the last reply. The bridge enforces a 10-minute hard kill. If the session never exits and no replies are being sent, check that `BRAIN.md`'s Session Follow-up Checklist outputs `NO_NEW_MSG` when there is nothing to reply to.

**Session seems stuck polling with no activity**
If `run.sh` logs "No follow-up detected" repeatedly for an unusually long time, `SESSION_DURATION` may be set too high. The default is 300 seconds. Override with `export SESSION_DURATION=60` before starting the bridge.

**No "WebSocket proxy installed" log in Teams console**
The interceptor may not have loaded before Teams. Check `chrome://extensions` → Son of Claude Watcher is enabled, then hard-refresh the Teams tab (`Ctrl+Shift+R`). The interceptor must run at `document_start` before Teams establishes its WebSocket connections.

**Interceptor logs messages but bridge terminal shows nothing**
Check the service worker console for errors. The bridge.js → background.js → trigger-server chain requires all three to be functional. Common cause: the bridge server is not running (`node trigger-server.js`).

**Claude replies to own messages / triggers on self-sent messages**
The interceptor learns the self-ID from outgoing `WebSocket.send()` calls. If no outgoing message has been sent since page load, the self-ID is unknown. Send any message manually in Teams to prime the self-detection, then the issue resolves.

**Unknown Entra ID notification keeps appearing**
Map the ID at `http://localhost:3000/identities`. The notification fires each time a trigger arrives with an unmapped sender ID.

**Messages from other people are delayed, not ignored**
This is expected. The bridge queues triggers while a session is active and processes them after the current session ends and the 10s cooldown expires. Check `GET http://localhost:3000/status` for `{ "active": true/false, "queueLength": N }` to see current state.

**The same message triggered Claude twice**
The bridge deduplicates by `conversationId + sender + text`. If the text differs slightly (e.g. HTML vs plain text), it won't be caught as a duplicate. Check the bridge terminal logs for `[Queue] Dropped duplicate` to confirm deduplication is firing.

---

## Disclaimer

Agentic AI tools operating through browser automation are susceptible to prompt injection attacks and other adversarial inputs. Review Claude's behavior regularly. The author assumes no responsibility for unintended actions, data exposure, or misuse. Use at your own discretion.
