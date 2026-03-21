# Son of Claude (Based of https://github.com/asarnaout/son-of-claude)

A browser-automation agent that monitors Microsoft Teams and responds to messages on your behalf — no Graph API, no webhooks, no admin permissions required. Uses your existing Chrome session.

---

## Check DOCUMENTATION.MD for "Known Limitations" and Roadmap
---


## How It Works

When a new Teams message arrives, a Chrome extension detects the unread badge in the tab title and notifies a local Node.js bridge. The bridge spawns Claude Code with `--chrome`, which navigates Teams, reads the message, and responds. After the first reply, the session stays open for a configurable window (default: 2 minutes) and polls for follow-ups before exiting. Claude only runs when there is actual activity, saving tokens compared to a polling loop.

```
Teams tab title changes to "(N) Chat | Name"
  → Chrome extension detects unread count increase
    → POSTs to local bridge (127.0.0.1:3000)
      → Bridge spawns: bash run.sh session <model>
        → Claude reads BRAIN.md, navigates Teams, replies
          → Session loop polls for follow-ups every 10s
            → Loop exits after SESSION_DURATION seconds (default: 120)
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

In a separate terminal:

```bash
bash scripts/test-trigger.sh
```

Expected output:
```
HTTP Status: 200
{"status":"triggered","timestamp":"..."}
✅ Trigger accepted
```

In the bridge terminal you should see Claude spawning and running.

### Step 5 — Test with a real message

Have someone (or yourself from another device) send a message in Teams. Within a few seconds you should see:

```
[timestamp] Activity detected. Sender: unknown, Model: claude-sonnet-4-6
[timestamp] Triggering Claude...
```

Followed by Claude's output as it navigates Teams and replies.

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

> **Note:** Extension-level sender filtering is best-effort. The sender name is extracted from the Teams DOM and may not always be available. `BRAIN.md`'s Do Not Respond List is the reliable safety gate.

---

## Reloading After Changes

| What you changed | What to do |
|------------------|-----------|
| `extension/*.js` or `extension/manifest.json` | `chrome://extensions` → Son of Claude Watcher → ↺ Reload, then refresh the Teams tab |
| `BRAIN.md` or `SOUL.md` | No restart needed — Claude reads them fresh each invocation |
| `trigger-server.js` | Stop bridge (`Ctrl+C`), restart with `node trigger-server.js` |
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
If `run.sh` logs "No follow-up detected" repeatedly for an unusually long time, `SESSION_DURATION` may be set too high. The default is 120 seconds. Override with `export SESSION_DURATION=60` before starting the bridge.

---

## Disclaimer

Agentic AI tools operating through browser automation are susceptible to prompt injection attacks and other adversarial inputs. Review Claude's behavior regularly. The author assumes no responsibility for unintended actions, data exposure, or misuse. Use at your own discretion.
