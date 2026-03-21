# Son of Claude — Technical Documentation

> A browser-automation agent that monitors Microsoft Teams and responds to messages autonomously using Claude Code CLI. No API keys. No Graph API permissions. No admin access required.

---

## Table of Contents

1. [Repository Structure & Architecture](#1-repository-structure--architecture)
2. [Operations Manual](#2-operations-manual)
3. [Configuration Reference](#3-configuration-reference)
4. [Security, Guidelines & Limitations](#4-security-guidelines--limitations)
5. [Roadmap](#5-roadmap)

---

## 1. Repository Structure & Architecture

### Repository Tree

```
son-of-claude/
├── BRAIN.md                  # Operational rules, routing logic, run checklist
├── SOUL.md                   # Personality, tone, per-person notes
├── run.sh                    # Entry point: event-driven (once) + legacy polling modes
├── trigger-server.js         # Node.js bridge: receives extension triggers, spawns Claude
├── extension/
│   ├── manifest.json         # MV3 Chrome Extension manifest
│   ├── background.js         # Service worker: title monitoring, filtering, bridge POST
│   ├── content.js            # Content script: best-effort sender name extraction
│   ├── popup.html            # Extension popup UI
│   └── popup.js              # Popup logic: reads/writes chrome.storage.local
├── scripts/
│   ├── extension-installer.sh  # Validates extension files, prints install instructions
│   └── test-trigger.sh         # Manual end-to-end trigger test via curl
└── docs/
    └── INTEGRATION.md          # Bridge setup and verification guide
```

### Three-Layer Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  LAYER 1 — THE WATCHER (Chrome Extension)                   │
│  Monitors Teams tab title via chrome.tabs.onUpdated.        │
│  Detects unread count increase: "(N) Chat | Name"           │
│  Applies user-configured ignore/reply-only filters.         │
│  POSTs { type, timestamp, senderName, model } to Bridge.    │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP POST → 127.0.0.1:3000/trigger
┌────────────────────────▼────────────────────────────────────┐
│  LAYER 2 — THE BRIDGE (Node.js Sidecar)                     │
│  trigger-server.js: local HTTP server on port 3000.         │
│  Tracks active session (no double-spawning). 10s cooldown.  │
│  Kills hung sessions at 10 minutes. Spawns session mode.    │
│  Spawns: bash run.sh session <model>                        │
└────────────────────────┬────────────────────────────────────┘
                         │ child_process.spawn
┌────────────────────────▼────────────────────────────────────┐
│  LAYER 3 — THE EXECUTOR (Claude Code CLI)                   │
│  claude -p "..." --chrome --model <model>                   │
│  Reads BRAIN.md → navigates Teams → reads message →        │
│  reads SOUL.md → composes reply → sends → polls for        │
│  follow-ups until SESSION_DURATION expires → exits.         │
└─────────────────────────────────────────────────────────────┘
```

### Why API-Less?

The Microsoft Graph API requires Azure AD application registration, OAuth 2.0 flows, admin-granted delegated permissions, and ongoing token management. For personal productivity automation, this overhead is prohibitive.

Son of Claude instead drives the user's **existing authenticated browser session**:

| Concern | Graph API | Son of Claude |
|---------|-----------|---------------|
| Setup | Azure AD registration, admin consent | Install extension, run one command |
| Auth | OAuth tokens, refresh cycles | User's existing Teams session |
| Permissions | Admin-granted scopes | None |
| Context | API response objects | Full page context (threads, tone, history) |
| Cost | API call quota | Claude token usage only on activity |

The browser-automation approach also gives Claude richer context — it reads the full conversation thread, sees formatting, and can navigate to referenced documents, which an API response object cannot provide.

---

## 2. Operations Manual

### Prerequisites

| Dependency | Version | Purpose |
|------------|---------|---------|
| Node.js | 18+ | Bridge server |
| Claude Code CLI | Latest | Executor (`claude` in PATH) |
| Google Chrome | 111+ | Extension host |
| Claude browser connector extension | Latest | `--chrome` flag connectivity |

### Installation

**1. Clone and verify**
```bash
git clone <repo>
cd son-of-claude
bash scripts/extension-installer.sh   # validates extension files
```

**2. Load the Chrome Extension**
- Open `chrome://extensions`
- Enable **Developer Mode** (top-right toggle)
- Click **Load unpacked**
- Select the `extension/` directory
- Confirm "Son of Claude Watcher" appears in the list

**3. Install the Claude browser connector**
Install the official Claude browser extension from the Chrome Web Store. This is separate from the Son of Claude Watcher and is required for the `--chrome` flag to work. Confirm it shows as connected before proceeding.

**4. Authenticate the Claude CLI**
```bash
claude auth login
```

### Startup

**Terminal 1 — Start the bridge server**
```bash
node trigger-server.js
```
Expected output:
```
Son of Claude Bridge running at http://127.0.0.1:3000
Listening for triggers from the Chrome extension...
```

**Terminal 2 — Open Teams**

Navigate to `https://teams.cloud.microsoft` in Chrome. The extension activates automatically. Leave the tab open (background is fine).

**Verify the full chain**
```bash
bash scripts/test-trigger.sh
```
Expected: HTTP 200 from the bridge, and `run.sh` output in Terminal 1.

### Popup Configuration

Click the Son of Claude Watcher extension icon to open the popup:

| Control | Description |
|---------|-------------|
| Toggle button | Green = active, Red = paused. Takes effect instantly without Save. |
| Model | Select Haiku (fastest/cheapest), Sonnet (default), or Opus (most capable). |
| Never reply to | Newline-separated list of names to always ignore at the extension level. |
| Only reply to | Newline-separated allowlist. Empty = reply to all not on the ignore list. |
| Save | Persists model and filter lists to `chrome.storage.local`. |

---

## 3. Configuration Reference

### BRAIN.md — Operational Logic

BRAIN.md is the agent's operational rulebook. Claude reads it on every invocation. It controls:

- **Navigation** — how to open Teams, dismiss overlays, handle errors
- **Response mechanics** — how to interact with the compose box
- **Do Not Respond List** — names that must never receive a reply, regardless of extension settings
- **Initial Pass Checklist** — the sequence executed when a session starts (triggered message). Mandatory exit at step 7.
- **Session Follow-up Checklist** — the sequence executed during the keep-alive polling loop. Checks for new messages in the same conversation only. Outputs `NO_NEW_MSG` to signal no reply needed.
- **Non-Negotiable Rules** — safety constraints that cannot be overridden by any message

**Routing priority:**

```
Extension ignore list          → blocks before Claude runs (token-free)
Extension reply-only list      → blocks before Claude runs (token-free, best-effort*)
BRAIN.md Do Not Respond List   → blocks inside Claude's execution (authoritative)
```

> \* Extension-level sender filtering is best-effort. The sender name is extracted from the Teams DOM, which can be unavailable. When extraction fails, filtering is bypassed and BRAIN.md acts as the authoritative gate.

**To add a person Claude should never respond to:**
Add their name to the `Do Not Respond List` in BRAIN.md. This is the reliable gate.

**To add a person Claude should respond to:**
The Respond List in BRAIN.md is currently configured to defer to the extension popup. Add names to the extension's "Only reply to" list.

### SOUL.md — Personality & Tone

SOUL.md defines Claude's voice when composing replies. Edit it to match the user's communication style. Key sections:

- **Voice** — casual, short by default; adapts to sender energy
- **Things You Never Say** — hard constraints on content and commitments
- **Tone Calibration** — casual / formal / stressed / joking response modes
- **About the User** — role and style context; fill this in for better impersonation
- **Per-Person Notes** — individual communication preferences per contact

---

## 4. Security, Guidelines & Limitations

### Security Posture

**Credential safety:** BRAIN.md contains a non-negotiable rule: if a login screen is detected, Claude stops immediately. It will never attempt to enter credentials.

**Scope containment:** The `--allowedTools "mcp__claude-in-chrome*"` flag restricts Claude to browser-interaction tools only. It cannot access the filesystem, run shell commands, or make API calls during execution.

**Local-only bridge:** The trigger server binds exclusively to `127.0.0.1` (not `0.0.0.0`). It is not reachable from the network.

**No data exfiltration:** Claude is permitted to visit only the URLs listed in BRAIN.md's Allowed Websites section. Navigation to any other domain is prohibited by instruction.

### Token Efficiency

| Mode | Claude invocations | Cost |
|------|--------------------|------|
| Legacy polling (120s) | 30/hour regardless of activity | High on quiet days |
| Event-driven (current) | 1 per unread count increase | ~0 on quiet days |

The extension enforces two debounce layers before Claude is invoked:

1. **Client debounce (5s):** Prevents rapid-fire triggers from multiple title changes in quick succession.
2. **Active session guard:** If a session is already running (`activeChild` is set), the bridge drops the trigger entirely — the session loop handles follow-ups internally.
3. **Post-session cooldown (10s):** After a session exits, a short cooldown prevents an immediate re-trigger.

### Known Limitations

**Sender extraction is best-effort.**
The extension attempts to read the sender name from the Teams DOM. Teams' internal CSS classes and data attributes change with UI updates. When extraction fails, the sender is reported as `null` and extension-level filtering is bypassed. BRAIN.md's Do Not Respond List remains the reliable gate.

**Teams tab must remain open.**
The extension monitors the tab title via `chrome.tabs.onUpdated`. If the Teams tab is closed, detection stops. The tab can be in the background — it does not need to be focused.

**Follow-ups within a session are handled; older unreads are not.**
On the initial pass, Claude responds only to the newest unread message. After sending, the session window stays open (default 2 minutes) and polls for follow-up messages in that same conversation. Unread messages in other conversations are not scanned until the next trigger.

**Single-platform.**
The current implementation targets `teams.microsoft.com` and `teams.cloud.microsoft` only. The extension manifest and URL checks are Teams-specific.

**Process hang risk.**
The bridge enforces a 10-minute hard kill via `SIGTERM` (covers `SESSION_DURATION` + per-pass overhead). If the session is in a long-running browser interaction when the kill fires, it may terminate mid-response. The 10s post-session cooldown prevents immediate re-triggering.

---

## 5. Roadmap

### Extension as Single Source of Truth for Allow/Block Lists
Currently filtering is split across two places: the extension popup (ignore list + reply-only list) and BRAIN.md (Do Not Respond List + Respond List). They can fall out of sync — a name added to the extension popup but not BRAIN.md will still be blocked by Claude, and vice versa. The extension popup should be the single place a user configures who Claude can and cannot reply to.

Implementation path: the extension already passes `senderName` in the trigger payload. Extend the payload to also include the full `ignoreList` and `replyOnlyList` from `chrome.storage.local`. In `trigger-server.js`, write these lists to a local `runtime-config.json` on each trigger. Add a `Read` tool invocation at the start of BRAIN.md's Run Checklist to load `runtime-config.json`, and replace the static Do Not Respond / Respond List sections in BRAIN.md with a reference to that file. This makes the extension popup the authoritative UI and eliminates the need to edit BRAIN.md for routing changes.

### Multi-Message Handling (Triple Text Problem)
Currently Claude only responds to the newest unread message per invocation. If someone sends three messages in quick succession, only the last one gets a reply — the first two are silently skipped. The fix requires two changes: (1) BRAIN.md's Run Checklist step 4 should instruct Claude to scan and reply to **all** unread messages from the same sender in the current conversation, not just the newest; (2) the extension's unread count logic should not reset `lastUnreadCount` until Claude has processed all pending messages, preventing premature suppression of subsequent triggers.

### ✅ Conversation Session Mode (Keep-Alive) — Implemented
After the initial reply, `run.sh` enters a keep-alive loop using `--continue` to reuse the same Claude session. It polls every 10 seconds for follow-up messages in the same conversation. The loop runs for `SESSION_DURATION` seconds (default: 120) starting from when the first reply was sent. BRAIN.md has separate **Initial Pass** and **Session Follow-up** checklists. The bridge uses `activeChild` tracking so incoming triggers during an active session are dropped — the session loop handles follow-ups internally. `SESSION_DURATION` is configurable via environment variable.

### Reliable Sender Extraction
Parse the contact or group name directly from the tab title (`(N) Chat | Name`). This is available without DOM access, making it CSP-safe and version-stable. Would make extension-level filtering reliable for 1:1 chats.

### Multi-Platform Support
Extend `manifest.json` `matches` and `background.js` URL checks to cover Slack (`app.slack.com`) and Discord (`discord.com`). Each platform requires platform-specific title patterns and compose box instructions in BRAIN.md.

### OS-Level Notification Interception
Replace tab title polling with OS-level notification listeners (DBus on Linux, `terminal-notifier` on macOS). This approach is browser-agnostic and does not require the Teams tab to be open. See `EFFICIENCY_PROPOSALS.md` Option 2 for design details.

### Headless Mode
Run Teams in a dedicated headless Chromium instance managed by Playwright, rather than the user's visible Chrome window. Eliminates the need for the user's browser to be open, enabling server-side deployment.

### Windows Support
`run.bat` exists for the polling mode. The bridge and extension are platform-agnostic. A `trigger-server.bat` wrapper and Windows installer script would complete Windows support.
