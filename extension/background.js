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
  if (!match) return;

  const currentCount = match[0] === '*' ? Infinity : parseInt(match[0], 10);
  if (currentCount <= lastUnreadCount) {
    console.log(`Son of Claude: Unread count did not increase (${lastUnreadCount} → ${currentCount}). Ignoring.`);
    lastUnreadCount = currentCount;
    return;
  }
  lastUnreadCount = currentCount;

  console.log(`Son of Claude: Activity detected. Unread count increased to ${currentCount}.`);

  // Request sender name from content script (best-effort)
  chrome.tabs.sendMessage(tabId, { type: 'GET_SENDER' }, (response) => {
    // Suppress errors if content script isn't ready
    if (chrome.runtime.lastError) {
      console.log('Son of Claude: Content script not available for sender extraction.');
    }
    const senderName = (response && response.senderName) || null;
    handleTrigger(senderName, tab.url);
  });
});

// --- Trigger handler (shared logic) ---
function handleTrigger(senderName, source) {
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
      .then(data => console.log('Son of Claude: Bridge response:', data))
      .catch(err => console.error('Son of Claude: Bridge server unreachable. Is trigger-server.js running?', err));
  });
}
