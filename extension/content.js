// content.js — Sender extraction from Teams DOM.
// Detection is handled by background.js via chrome.tabs.onUpdated (title monitoring).
// This script responds to sender name requests from the service worker.

function extractSenderName() {
  try {
    // Strategy 1: Find "Unread" badges in the chat sidebar, walk up to the treeitem,
    // and extract the name from the line after "Unread" in the item's text.
    const candidates = document.querySelectorAll('*');
    for (const el of candidates) {
      if (el.innerText !== 'Unread' || el.children.length > 0) continue;

      // Walk up to find the treeitem (chat list item)
      let parent = el.parentElement;
      for (let i = 0; i < 8 && parent; i++) {
        if (parent.getAttribute('role') === 'treeitem') {
          const lines = parent.innerText.split('\n').map(l => l.trim()).filter(Boolean);
          const unreadIdx = lines.indexOf('Unread');
          if (unreadIdx !== -1 && unreadIdx + 1 < lines.length) {
            const name = lines[unreadIdx + 1];
            // Skip filter buttons (e.g. "Chats", "Meeting chats") and self-chat
            if (name && !name.includes('(You)') && name !== 'Chats' && name !== 'Meeting chats') {
              console.log('Son of Claude [content]: Unread sender from sidebar:', name);
              return name;
            }
          }
          break; // found the treeitem, don't keep walking up
        }
        // Skip if we hit the toolbar (sidebar filter, not a chat item)
        if (parent.getAttribute('role') === 'toolbar') break;
        parent = parent.parentElement;
      }
    }

    // Strategy 2 (fallback): open conversation author
    const byDataTid = document.querySelector('[data-tid="message-author-name"]');
    if (byDataTid && byDataTid.innerText.trim()) {
      console.log('Son of Claude [content]: Sender from message-author-name (fallback)');
      return byDataTid.innerText.trim();
    }

    const byPersona = document.querySelector('.fui-Persona__primaryText');
    if (byPersona && byPersona.innerText.trim()) {
      console.log('Son of Claude [content]: Sender from Persona (fallback)');
      return byPersona.innerText.trim();
    }
  } catch (e) {
    console.error('Son of Claude [content]: extractSenderName error:', e);
  }
  return null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_SENDER') {
    sendResponse({ senderName: extractSenderName() });
  }
});
