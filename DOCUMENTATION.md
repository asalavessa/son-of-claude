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
├── run.sh                    # Entry point: session, once, and legacy polling modes
├── trigger-server.js         # Node.js bridge: receives triggers, spawns Claude, identity cache
├── identity-cache.json       # Entra ID → display name mappings (auto-created, editable via admin UI)
├── extension/
│   ├── manifest.json         # MV3 Chrome Extension manifest (dual-world content scripts)
│   ├── interceptor.js        # MAIN world: WebSocket monkey-patch, SignalR frame parsing
│   ├── bridge.js             # ISOLATED world: relays intercepted data to background.js
│   ├── background.js         # Service worker: WS + title detection, filtering, bridge POST
│   ├── content.js            # Content script: legacy best-effort sender name extraction
│   ├── popup.html            # Extension popup UI
│   └── popup.js              # Popup logic: reads/writes chrome.storage.local
├── scripts/
│   ├── extension-installer.sh  # Validates extension files, prints install instructions
│   ├── test-trigger.sh         # Manual end-to-end trigger test (legacy path)
│   └── test-websocket.sh       # Manual test for enriched WebSocket payload path
└── docs/
    └── INTEGRATION.md          # Bridge setup and verification guide
```

### Three-Layer Architecture

The system has two parallel detection paths — **WebSocket interception** (primary, high-fidelity) and **tab title monitoring** (legacy fallback). Both feed into the same bridge and executor.

```
┌─────────────────────────────────────────────────────────────────┐
│  LAYER 1 — THE WATCHER (Chrome Extension)                       │
│                                                                  │
│  PATH A — WebSocket Interception (Primary)                       │
│    interceptor.js (MAIN world, document_start):                  │
│      Monkey-patches WebSocket constructor before Teams loads.    │
│      Parses SignalR frames (0x1E delimiter), filters noise.      │
│      Extracts: sender, senderId, text, conversationId.           │
│      Filters out self-messages (learned from outgoing send()).   │
│      Dispatches CustomEvent → bridge.js                          │
│    bridge.js (ISOLATED world):                                   │
│      Dumb pipe. Relays CustomEvent → background.js               │
│      via chrome.runtime.sendMessage. 2s dedup debounce.          │
│    background.js:                                                │
│      Batches messages in 3s window. Applies sender filters.      │
│      POSTs enriched payload to Bridge.                           │
│                                                                  │
│  PATH B — Tab Title Monitoring (Fallback)                        │
│    background.js (service worker):                               │
│      Monitors tab title for "(N) Chat | Name" via onUpdated.    │
│      Requests sender from content.js (best-effort DOM scrape).  │
│      POSTs legacy payload to Bridge.                             │
│                                                                  │
│  Both paths apply ignore/reply-only filters from popup settings. │
└────────────────────────┬────────────────────────────────────────┘
                         │ HTTP POST → 127.0.0.1:3000/trigger
┌────────────────────────▼────────────────────────────────────────┐
│  LAYER 2 — THE BRIDGE (Node.js Sidecar)                         │
│  trigger-server.js: local HTTP server on port 3000.             │
│  /trigger always accepts — deduplicates, queues, returns 202.   │
│  FIFO messageQueue: batches same-conversation messages.         │
│  processQueue() spawns Claude when idle; retries after cooldown.│
│  Identity cache lookup. Smart deep-links (.v2 only).            │
│  Stale tasks (>1h) pruned automatically.                        │
│  GET /status — { active, queueLength } for extension polling.   │
│  GET/POST /identities — admin UI for Entra ID→name mapping.    │
│  Spawns: bash run.sh session <model> <url> <sender> <text>      │
└────────────────────────┬────────────────────────────────────────┘
                         │ child_process.spawn
┌────────────────────────▼────────────────────────────────────────┐
│  LAYER 3 — THE EXECUTOR (Claude Code CLI)                       │
│  claude -p "..." --chrome --model <model>                       │
│  Reads BRAIN.md → navigates Teams (deep-link if available) →   │
│  reads ALL unread messages → reads SOUL.md → composes reply →  │
│  sends → polls for follow-ups until SESSION_DURATION expires.   │
└─────────────────────────────────────────────────────────────────┘
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
| Tab title event-driven | 1 per unread count increase | ~0 on quiet days |
| WebSocket interception | 1 per message batch (with exact text) | ~0 on quiet days, fewer DOM reads |

The WebSocket path provides additional token savings because the exact message text and sender are passed directly to Claude, eliminating the need for DOM navigation to discover who sent what.

The system uses layered deduplication and queueing rather than dropping triggers:

1. **Bridge.js dedup debounce (2s):** Suppresses duplicate `CustomEvent` dispatches for the same sender+text before they leave the extension.
2. **Batch accumulation window (3s):** Multiple messages arriving within 3 seconds are combined into one trigger before the bridge POST.
3. **Client debounce (5s):** Prevents rapid-fire triggers from the tab-title monitoring path.
4. **Server-side deduplication (`processedSignatures` Set):** The bridge fingerprints each trigger as `conversationId|senderName|messageText`. Exact duplicates are rejected with `ignored_duplicate` regardless of queue state. The Set is capped at 500 entries (FIFO eviction).
5. **FIFO message queue:** Instead of dropping triggers when a session is active, the bridge queues them. `processQueue()` spawns Claude as soon as the previous session ends and the cooldown expires. Messages for the same conversation are batched together before spawning.
6. **Active session guard (extension-side):** While `wsSessionActive` is true, the extension suppresses new WS batch flushes. It polls `GET /status` every 10s; once `active: false` is returned, triggers re-enable.
7. **Post-session cooldown (10s):** After a session exits, a short cooldown prevents the queue from spawning immediately — allows Teams state to settle. During cooldown, new `/trigger` POSTs are rejected (not queued).

### Known Limitations

**Sender extraction is best-effort on the legacy path; reliable on the WebSocket path.**
The WebSocket interceptor extracts the exact sender display name and Entra ID directly from SignalR frames — no DOM dependency. The legacy tab-title path still relies on content.js DOM scraping, which can fail when Teams updates its UI. When extraction fails on either path, the sender is reported as `null` and extension-level filtering is bypassed. BRAIN.md's Do Not Respond List remains the reliable gate.

**WebSocket frame structure is speculative.**
The SignalR JSON paths used by the interceptor (e.g. `parsed.arguments[0].resourceType === "NewMessage"`, `resource.from.displayName`) are based on observed Teams v2 behavior. Microsoft may change the frame schema without notice. When parsing fails, the interceptor silently passes frames through unmodified and the system falls back to tab-title detection.

**Self-message detection depends on runtime learning.**
The interceptor filters out the user's own messages by learning the self-ID from outgoing `WebSocket.send()` calls. Until the user sends their first message after page load, the self-ID is unknown and outgoing echoes may briefly trigger false positives. Page globals (`__NEXT_DATA__`) are also checked as a fallback.

**Teams tab must remain open.**
The extension monitors the tab title via `chrome.tabs.onUpdated`. If the Teams tab is closed, detection stops. The tab can be in the background — it does not need to be focused.

**Concurrent conversations are queued, not dropped.**
If Claude is responding to Alice and Bob sends a message, Bob's trigger is queued in the bridge. When Alice's session finishes (and the 10s cooldown expires), the queue processor picks up Bob's task automatically with full context preserved. Messages are never lost due to concurrency. However, the queue is in-memory — restarting `trigger-server.js` clears it.

**Single-platform.**
The current implementation targets `teams.microsoft.com` and `teams.cloud.microsoft` only. The extension manifest and URL checks are Teams-specific.

**Process hang risk.**
The bridge enforces a 10-minute hard kill via `SIGTERM` (covers `SESSION_DURATION` + per-pass overhead). If the session is in a long-running browser interaction when the kill fires, it may terminate mid-response. The 10s post-session cooldown prevents immediate re-triggering.

---

## 5. Roadmap

### Extension as Single Source of Truth for Allow/Block Lists
Currently filtering is split across two places: the extension popup (ignore list + reply-only list) and BRAIN.md (Do Not Respond List + Respond List). They can fall out of sync — a name added to the extension popup but not BRAIN.md will still be blocked by Claude, and vice versa. The extension popup should be the single place a user configures who Claude can and cannot reply to.

Implementation path: the extension already passes `senderName` in the trigger payload. Extend the payload to also include the full `ignoreList` and `replyOnlyList` from `chrome.storage.local`. In `trigger-server.js`, write these lists to a local `runtime-config.json` on each trigger. Add a `Read` tool invocation at the start of BRAIN.md's Run Checklist to load `runtime-config.json`, and replace the static Do Not Respond / Respond List sections in BRAIN.md with a reference to that file. This makes the extension popup the authoritative UI and eliminates the need to edit BRAIN.md for routing changes.

### ✅ Multi-Message & Concurrent Conversation Handling — Implemented
Triggers are never dropped when Claude is busy. The bridge maintains a FIFO `messageQueue`; `/trigger` always accepts payloads (returning `202 queued`) and `processQueue()` spawns Claude as soon as the current session ends. Messages for the same conversation are batched before spawning. Server-side deduplication (`processedSignatures` Set, capped at 500) prevents exact-duplicate triggers from queueing. Stale queue entries older than 1 hour are pruned automatically. On the extension side, `lastUnreadCount` is committed when the bridge responds `queued` or `session_started`; cooldown rejections preserve the old value so the tab-title path can re-trigger after cooldown.

### ✅ Conversation Session Mode (Keep-Alive) — Implemented
After the initial reply, `run.sh` enters a keep-alive loop using `--continue` to reuse the same Claude session. It polls every 10 seconds for follow-up messages in the same conversation. The loop runs for `SESSION_DURATION` seconds (default: 120) starting from when the first reply was sent. BRAIN.md has separate **Initial Pass** and **Session Follow-up** checklists. The bridge uses `activeChild` tracking so incoming triggers during an active session are dropped — the session loop handles follow-ups internally. `SESSION_DURATION` is configurable via environment variable.

### ✅ Reliable Sender Extraction — Implemented (WebSocket Interception)
Rather than parsing the tab title or scraping the DOM, the extension now intercepts SignalR WebSocket frames in a MAIN world content script (`interceptor.js`). This extracts the exact sender display name, Entra ID, message text, and conversation ID directly from the raw JSON payloads — milliseconds before the UI updates. A bridge script (`bridge.js`) in ISOLATED world relays the data to the service worker, which batches messages (3s window), applies sender filters, and POSTs enriched payloads to the trigger-server. The server resolves unknown Entra IDs via a local identity cache (`identity-cache.json`, editable at `http://localhost:3000/identities`) and generates deep-links for private chats. Self-messages are filtered out by learning the user's ID from outgoing `WebSocket.send()` calls. The legacy tab-title path remains as a parallel fallback.

### Multi-Platform Support
Extend `manifest.json` `matches` and `background.js` URL checks to cover Slack (`app.slack.com`) and Discord (`discord.com`). Each platform requires platform-specific title patterns and compose box instructions in BRAIN.md.

### OS-Level Notification Interception
Replace tab title polling with OS-level notification listeners (DBus on Linux, `terminal-notifier` on macOS). This approach is browser-agnostic and does not require the Teams tab to be open. See `EFFICIENCY_PROPOSALS.md` Option 2 for design details.

### Headless Mode
Run Teams in a dedicated headless Chromium instance managed by Playwright, rather than the user's visible Chrome window. Eliminates the need for the user's browser to be open, enabling server-side deployment. Blocked by Chrome requiring `--user-data-dir` for `--remote-debugging-port`, which creates profile isolation issues (separate auth, no extensions).

### Windows Support
`run.bat` exists for the polling mode. The bridge and extension are platform-agnostic. A `trigger-server.bat` wrapper and Windows installer script would complete Windows support.
