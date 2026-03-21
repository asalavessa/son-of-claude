// content.js — Sender extraction only.
// Detection is handled by background.js via chrome.tabs.onUpdated (title monitoring).
// This script responds to sender name requests from the service worker.

function extractSenderName() {
  try {
    const byDataTid = document.querySelector('[data-tid="message-author-name"]');
    if (byDataTid && byDataTid.innerText.trim()) return byDataTid.innerText.trim();

    const byPersona = document.querySelector('.fui-Persona__primaryText');
    if (byPersona && byPersona.innerText.trim()) return byPersona.innerText.trim();
  } catch (_) {}
  return null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_SENDER') {
    sendResponse({ senderName: extractSenderName() });
  }
});
