# Implementation Plan: In-Memory Message Queue

This document outlines the technical strategy for introducing an In-Memory Message Queue to the "Son of Claude" Node.js bridge. This upgrade ensures that high-value WebSocket triggers are never dropped when the agent is busy, solving several concurrency and data-loss issues inherent in the current "Drop if Busy" architecture.

## 1. Problem Statement (The Issues)

The current `trigger-server.js` implements a strict concurrency guard: if `activeChild` is true (Claude is running), any incoming `/trigger` POST requests are immediately rejected with a `429` or `200 {status: "active_session_exists"}`. 

While this prevents multiple Claude instances from fighting over the keyboard and mouse, it creates three significant bottlenecks:

1.  **Loss of Rich Context:** When a WebSocket trigger is dropped, the rich metadata (`messageText`, `sender`, `conversationId`) is lost forever. When Claude eventually finishes its current task, it relies on the slow, fallback tab-title monitor to notice the missed message, forcing it to perform an expensive, 30-second DOM scan to figure out what it missed.
2.  **Concurrent Conversations:** If Claude is currently replying to Alice, and Bob sends a message, Bob's trigger is dropped. Claude finishes with Alice and exits. Bob's message sits unread until the fallback polling catches it.
3.  **The "Triple Text" Burst:** If Alice sends three distinct messages in a 5-second window, Message 1 starts Claude. Messages 2 and 3 are dropped because Claude is booting up. 

## 2. Solution Design (In-Memory Queue)

We will implement a lightweight, asynchronous FIFO (First-In, First-Out) queue directly inside `trigger-server.js`. 

By decoupling the **Reception** of a trigger from the **Execution** of the agent, the bridge can hoard incoming WebSocket payloads safely in memory. As soon as the agent finishes its current task, the bridge instantly feeds it the next queued payload, preserving the high-speed "Deep-Link" context.

### Key Architectural Shifts:
*   **Always Accept:** The `/trigger` endpoint will no longer return `active_session_exists`. It will always accept the payload, push it to an array, and return `202 Accepted`.
*   **Event-Driven Processing:** A standalone `processQueue()` function will be responsible for checking if `activeChild` is free and, if so, popping the next task from the array and spawning Claude.
*   **Same-Sender Concatenation (Bonus):** Before spawning Claude, the queue processor can gather all pending messages from the *same sender* and combine them into a single prompt, elegantly solving the "Triple Text" problem.

---

## 3. Implementation Guide

### Step 1: Initialize the Queue State
Open `trigger-server.js` and establish the global state variables.

```javascript
let activeChild = null;
let cooldownUntil = 0;
let messageQueue = []; // The new in-memory queue
let processedSignatures = new Set(); // Tracks recent messages to prevent duplicates
```

### Step 2: Refactor the HTTP Receiver
Update the `/trigger` POST handler. Remove the `activeChild` rejection block. Instead, implement a deduplication check, push the incoming payload into the array, and call the processor.

```javascript
// Inside the req.on('end') block:
let payload = {};
try { payload = JSON.parse(body); } catch (_) {}

// Require essential fields to prevent queuing garbage
if (!payload.sender || !payload.conversationId) {
    res.writeHead(400);
    return res.end(JSON.stringify({ error: "Missing sender or conversationId" }));
}

// --- NEW: Deduplication Logic ---
// Create a unique fingerprint for this exact message
const msgSignature = `${payload.conversationId}|${payload.sender}|${payload.text}`;

if (processedSignatures.has(msgSignature)) {
    console.log(`[Queue] Dropped duplicate message from ${payload.sender}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ status: 'ignored_duplicate' }));
}

// Record the signature and cap the Set size to prevent memory leaks
processedSignatures.add(msgSignature);
if (processedSignatures.size > 500) {
    const oldest = processedSignatures.values().next().value;
    processedSignatures.delete(oldest);
}
// --------------------------------

// 1. Push to queue
messageQueue.push({
    timestamp: Date.now(),
    sender: payload.sender,
    text: payload.text || "",
    conversationId: payload.conversationId,
    model: payload.model || 'claude-sonnet-4-6'
});

console.log(`[Queue] Added message from ${payload.sender}. Pending tasks: ${messageQueue.length}`);

// 2. Acknowledge receipt to the extension instantly
res.writeHead(202, { 'Content-Type': 'application/json' });
res.end(JSON.stringify({ status: 'queued', queueLength: messageQueue.length }));

// 3. Attempt to process the queue
processQueue();
```

### Step 3: Implement the Queue Processor
Create a new function that manages the execution lifecycle. This function implements **Smart Concatenation**—if Alice sent 3 messages while Claude was busy, it combines them into one task.

```javascript
function processQueue() {
    // Guard clauses: Do nothing if busy, on cooldown, or queue is empty
    if (activeChild !== null) return;
    if (Date.now() < cooldownUntil) return;
    if (messageQueue.length === 0) return;

    // 1. Peek at the oldest message to identify the target conversation
    const targetConversationId = messageQueue[0].conversationId;
    const targetSender = messageQueue[0].sender;
    const model = messageQueue[0].model;

    // 2. Extract ALL messages matching this conversationId from the queue
    const matchingTasks = messageQueue.filter(m => m.conversationId === targetConversationId);
    
    // Remove the extracted tasks from the main queue
    messageQueue = messageQueue.filter(m => m.conversationId !== targetConversationId);

    // 3. Concatenate the text
    const combinedText = matchingTasks.map(m => m.text).join(" \n ");

    console.log(`[Process] Starting session for ${targetSender}. Combined ${matchingTasks.length} messages.`);
    
    // 4. Construct the high-speed deep-link
    const deepLink = `https://teams.microsoft.com/l/chat/${targetConversationId}/conversations`;

    // 5. Spawn Claude
    activeChild = spawn('bash', [RUN_SCRIPT, 'session', model, deepLink, targetSender, combinedText], {
      stdio: ['ignore', 'inherit', 'inherit']
    });

    // 6. Handle Completion
    activeChild.on('close', (code) => {
        activeChild = null;
        cooldownUntil = Date.now() + COOLDOWN_MS;
        console.log(`[Process] Session finished. Cooldown ${COOLDOWN_MS / 1000}s...`);
        
        // After cooldown, automatically check if more items are in the queue
        setTimeout(() => {
            console.log(`[Queue] Cooldown complete. Checking for pending tasks...`);
            processQueue();
        }, COOLDOWN_MS);
    });
}
```

### Step 4: Update `run.sh` Prompt Injection
Update `run.sh` to accept the new combined text variable (`$5`).

```bash
# run.sh (session mode block)
MODEL="${2:-claude-sonnet-4-6}"
URL="$3"
SENDER="$4"
COMBINED_TEXT="$5"

# Inject the exact text so Claude doesn't have to read the DOM
claude -p "ACT FAST: User '${SENDER}' said: '${COMBINED_TEXT}'. You are at ${URL}. Read the context and reply immediately per SOUL.md." \
  --chrome --model "${MODEL}" --allowedTools "mcp__claude-in-chrome*"
```

---

## 4. Edge Cases & Considerations

1. **Queue Bloat (Stale Data):** If Claude gets stuck for 30 minutes, the queue might fill up with dozens of outdated messages. You may want to add logic in `processQueue()` to drop messages where `Date.now() - m.timestamp > 3600000` (older than 1 hour).
2. **Persistent Storage:** Because this is an *in-memory* queue, restarting the `trigger-server.js` process will wipe out all pending messages. For personal automation, this is acceptable, as the extension's tab-title fallback will eventually re-trigger for unread messages anyway.
3. **Session Re-entry vs. New Spawn:** Currently, this architecture spawns a fresh `bash run.sh` for each item popped from the queue. If you want to feed new messages into an *already running* Claude session, you would have to transition to the Playwright "Stealth Sidecar" architecture, as the Claude CLI does not accept dynamic prompt injections while running.