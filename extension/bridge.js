// bridge.js — Dumb Pipe (ISOLATED World)
// Listens for TeamsMessageIntercepted CustomEvents from the MAIN world interceptor
// and relays them to background.js via chrome.runtime.sendMessage.
// Cannot fetch to localhost (Mixed Content) — background.js handles all network calls.

const DEBOUNCE_MS = 2000;
let lastRelayKey = '';
let lastRelayTime = 0;

window.addEventListener('TeamsMessageIntercepted', (event) => {
  const detail = event.detail;
  if (!detail) return;

  const sender = detail.sender;
  const text = detail.text;

  // Validate required fields
  if (typeof sender !== 'string' || !sender) return;
  if (typeof text !== 'string' || !text) return;

  // Debounce: same sender+text within 2s = duplicate
  const key = sender + text;
  const now = Date.now();
  if (key === lastRelayKey && (now - lastRelayTime) < DEBOUNCE_MS) {
    console.log('Son of Claude [bridge]: Debounced duplicate from', sender);
    return;
  }
  lastRelayKey = key;
  lastRelayTime = now;

  console.log('Son of Claude [bridge]: Relayed message from', sender);

  chrome.runtime.sendMessage({
    type: 'WS_MESSAGE_INTERCEPTED',
    detail: detail
  });
});
