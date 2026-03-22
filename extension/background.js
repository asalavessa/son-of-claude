// background.js — The Dispatcher
// Monitors Teams tab titles directly via chrome.tabs.onUpdated (no content script injection needed).
// Applies sender filtering, model selection, and POSTs to the local trigger-server bridge.

const BRIDGE_URL = 'http://127.0.0.1:3000/trigger';
const DEBOUNCE_MS = 5000;
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const ACTIVITY_REGEX = /\((\d+|\*)\)/;

let lastTriggerTime = 0;
let lastTitle = '';
let lastUnreadCount = 0;
let titleChangeTimeout = null; // 2s debounce on title changes — absorbs burst updates

function normalize(name) {
  return (name || '').trim().toLowerCase();
}

// --- Primary detection: tab title monitoring ---
// Teams updates the tab title to "(N) Chat | Name" on new messages.
// chrome.tabs.onUpdated fires from the service worker — no page injection, no CSP issues.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const isTeams = tab.url && (tab.url.includes('teams.microsoft.com') || tab.url.includes('teams.cloud.microsoft'));

  // Diagnostic: log ALL updates from Teams tabs
  if (isTeams) {
    console.log('Son of Claude [debug]: onUpdated fired. changeInfo:', JSON.stringify(changeInfo), 'title:', tab.title);
  }

  if (!changeInfo.title) return;
  if (!isTeams) return;

  const title = changeInfo.title;
  if (title === lastTitle) return;

  console.log('Son of Claude: Teams title changed:', lastTitle, '→', title);
  lastTitle = title;

  const match = title.match(ACTIVITY_REGEX);
  if (!match) {
    // No unread indicator — title cleared back to normal, reset the count
    if (lastUnreadCount !== 0) {
      console.log(`Son of Claude: No unread indicator in title. Resetting lastUnreadCount to 0.`);
      lastUnreadCount = 0;
    }
    return;
  }

  const currentCount = match[1] === '*' ? Infinity : parseInt(match[1], 10);
  if (currentCount === 0 || currentCount === lastUnreadCount) {
    console.log(`Son of Claude: Unread count unchanged (${lastUnreadCount} → ${currentCount}). Ignoring.`);
    return;
  }

  console.log(`Son of Claude: Activity detected. Unread count changed ${lastUnreadCount} → ${currentCount}.`);

  // 2s debounce: if title keeps changing rapidly, wait for it to settle before triggering
  if (titleChangeTimeout) clearTimeout(titleChangeTimeout);
  titleChangeTimeout = setTimeout(() => {
    titleChangeTimeout = null;
    // Request sender name from content script (best-effort)
    chrome.tabs.sendMessage(tabId, { type: 'GET_SENDER' }, (response) => {
      if (chrome.runtime.lastError) {
        console.log('Son of Claude: Content script not available for sender extraction.');
      }
      const senderName = (response && response.senderName) || null;
      handleTrigger(senderName, tab.url, currentCount);
    });
  }, 2000);
});

// --- WebSocket interception path ---
// Receives enriched payloads from bridge.js (which relays from the MAIN world interceptor).
// bridge.js cannot fetch to localhost (Mixed Content), so the Service Worker handles all network calls.
// Messages are batched in a 3-second accumulation window so rapid-fire messages are sent together.
let wsBatchQueue = [];       // Messages accumulated during the batch window
let wsBatchTimer = null;     // Timer for the batch window
let wsSessionActive = false; // True while a session is running — suppresses new WS triggers
const WS_BATCH_WINDOW_MS = 3000;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== 'WS_MESSAGE_INTERCEPTED') return;

  const detail = message.detail;
  if (!detail) return;

  console.log('Son of Claude [ws]: Received intercepted message from', detail.sender);

  // Suppress WS triggers while a session is already active — follow-up loop handles new messages
  if (wsSessionActive) {
    console.log('Son of Claude [ws]: Session active — suppressing WS trigger. Follow-up loop handles this.');
    return;
  }

  // Apply sender filtering before queueing
  chrome.storage.local.get(['model', 'ignoreList', 'replyOnlyList', 'enabled'], (settings) => {
    if (settings.enabled === false) {
      console.log('Son of Claude [ws]: Paused. Trigger ignored.');
      return;
    }

    const ignoreList = (settings.ignoreList || []).map(normalize);
    const replyOnlyList = (settings.replyOnlyList || []).map(normalize);
    const senderNorm = normalize(detail.sender);

    if (detail.sender) {
      if (ignoreList.includes(senderNorm)) {
        console.log(`Son of Claude [ws]: "${detail.sender}" is on the ignore list. Skipping.`);
        return;
      }
      if (replyOnlyList.length > 0 && !replyOnlyList.includes(senderNorm)) {
        console.log(`Son of Claude [ws]: "${detail.sender}" is not on the reply-only list. Skipping.`);
        return;
      }
    } else {
      console.log('Son of Claude [ws]: Sender unknown — bypassing filter (fail open). BRAIN.md handles downstream.');
    }

    // Queue the message
    wsBatchQueue.push({ detail, model: settings.model || DEFAULT_MODEL });
    console.log(`Son of Claude [ws]: Queued message (${wsBatchQueue.length} in batch).`);

    // Start or reset the batch window timer
    if (wsBatchTimer) clearTimeout(wsBatchTimer);
    wsBatchTimer = setTimeout(flushWsBatch, WS_BATCH_WINDOW_MS);
  });
});

function flushWsBatch() {
  wsBatchTimer = null;
  if (wsBatchQueue.length === 0) return;

  const batch = wsBatchQueue.splice(0);
  const now = Date.now();

  if (now - lastTriggerTime < DEBOUNCE_MS) {
    console.log('Son of Claude [ws]: Batch debounced (too soon since last trigger).');
    return;
  }

  // Use the first message's metadata for sender/conversation, combine all texts
  const first = batch[0];
  const allTexts = batch.map(m => m.detail.text).filter(Boolean);
  const combinedText = allTexts.join('\n---\n');
  const model = first.model;

  lastTriggerTime = now;

  const payload = {
    type: 'WS_MESSAGE_INTERCEPTED',
    timestamp: new Date().toISOString(),
    source: 'websocket',
    senderName: first.detail.sender,
    senderId: first.detail.senderId,
    messageText: combinedText,
    messageCount: batch.length,
    conversationId: first.detail.conversationId,
    replyToId: first.detail.replyToId,
    model
  };

  console.log(`Son of Claude [ws]: Flushing batch of ${batch.length} message(s) to bridge server...`, payload);

  fetch(BRIDGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })
    .then(res => res.json())
    .then(data => {
      console.log('Son of Claude [ws]: Bridge response:', data);
      if (data.status === 'session_started') {
        wsSessionActive = true;
        console.log('Son of Claude [ws]: Session started — suppressing further WS triggers until session ends.');
        pollForSessionEnd();
      } else {
        console.log(`Son of Claude [ws]: Trigger not accepted (${data.status}).`);
      }
      if (data.unknown_identity) {
        chrome.notifications.create({
          type: 'basic',
          iconUrl: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',
          title: 'Son of Claude — Unknown Sender',
          message: `Unresolved Entra ID: ${data.unknown_identity}\nMap it at http://localhost:3000/identities`
        });
      }
    })
    .catch(err => console.error('Son of Claude [ws]: Bridge server unreachable.', err));
}

// --- Session end detection ---
// Polls trigger-server /status every 10s while a WS session is active.
// Clears wsSessionActive when the session finishes so new WS triggers can fire.
function pollForSessionEnd() {
  if (!wsSessionActive) return;

  fetch('http://127.0.0.1:3000/status')
    .then(res => res.json())
    .then(data => {
      if (data.active) {
        // Session still running — check again in 10s
        setTimeout(pollForSessionEnd, 10000);
      } else {
        wsSessionActive = false;
        console.log('Son of Claude [ws]: Session ended — WS triggers re-enabled.');
      }
    })
    .catch(() => {
      // Server unreachable — assume session ended
      wsSessionActive = false;
      console.log('Son of Claude [ws]: Bridge unreachable — clearing session flag.');
    });
}

// --- Trigger handler (shared logic, legacy tab-title path) ---
function handleTrigger(senderName, source, currentUnreadCount) {
  const now = Date.now();
  if (now - lastTriggerTime < DEBOUNCE_MS) {
    console.log('Son of Claude: Trigger debounced (too soon since last trigger).');
    return;
  }

  chrome.storage.local.get(['model', 'ignoreList', 'replyOnlyList', 'enabled'], (settings) => {
    if (settings.enabled === false) {
      console.log('Son of Claude: Paused. Trigger ignored.');
      return;
    }

    const model = settings.model || DEFAULT_MODEL;
    const ignoreList = (settings.ignoreList || []).map(normalize);
    const replyOnlyList = (settings.replyOnlyList || []).map(normalize);
    const senderNorm = normalize(senderName);

    if (senderName) {
      if (ignoreList.includes(senderNorm)) {
        console.log(`Son of Claude: "${senderName}" is on the ignore list. Skipping.`);
        return;
      }
      if (replyOnlyList.length > 0 && !replyOnlyList.includes(senderNorm)) {
        console.log(`Son of Claude: "${senderName}" is not on the reply-only list. Skipping.`);
        return;
      }
    } else {
      console.log('Son of Claude: Sender unknown — bypassing filter (fail open). BRAIN.md handles downstream.');
    }

    lastTriggerTime = now;

    // Snapshot the count we're triggering on — only commit it if the bridge accepts the trigger
    const pendingCount = currentUnreadCount;

    const payload = {
      type: 'ACTIVITY_DETECTED',
      timestamp: new Date().toISOString(),
      source: source || 'unknown',
      senderName,
      model
    };

    console.log('Son of Claude: Sending trigger to bridge server...', payload);

    fetch(BRIDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(res => res.json())
      .then(data => {
        console.log('Son of Claude: Bridge response:', data);
        if (data.status === 'session_started') {
          // Bridge accepted the trigger — commit the count so we don't re-trigger for same backlog
          lastUnreadCount = pendingCount;
          console.log(`Son of Claude: lastUnreadCount committed to ${pendingCount}.`);
        } else {
          // active_session_exists, cooldown, or ignored — preserve lastUnreadCount so we can re-trigger later
          console.log(`Son of Claude: Trigger not accepted (${data.status}). Preserving lastUnreadCount at ${lastUnreadCount}.`);
        }
      })
      .catch(err => console.error('Son of Claude: Bridge server unreachable. Is trigger-server.js running?', err));
  });
}
