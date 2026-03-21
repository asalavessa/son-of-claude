// popup.js — Reads and writes extension settings to chrome.storage.local

const DEFAULT_MODEL = 'claude-sonnet-4-6';

function parseLines(text) {
  return text.split('\n').map(s => s.trim()).filter(Boolean);
}

function applyToggleUI(enabled) {
  const btn = document.getElementById('toggleBtn');
  btn.textContent = enabled ? '● Active — click to pause' : '○ Paused — click to activate';
  btn.className = enabled ? 'on' : 'off';
}

document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['model', 'ignoreList', 'replyOnlyList', 'enabled'], (settings) => {
    const model = settings.model || DEFAULT_MODEL;
    const radio = document.querySelector(`input[name="model"][value="${model}"]`);
    if (radio) radio.checked = true;

    document.getElementById('ignoreList').value = (settings.ignoreList || []).join('\n');
    document.getElementById('replyOnlyList').value = (settings.replyOnlyList || []).join('\n');

    // Default to enabled if never set
    applyToggleUI(settings.enabled !== false);
  });

  document.getElementById('toggleBtn').addEventListener('click', () => {
    chrome.storage.local.get(['enabled'], (settings) => {
      const newState = settings.enabled === false ? true : false;
      chrome.storage.local.set({ enabled: newState }, () => {
        applyToggleUI(newState);
      });
    });
  });

  document.getElementById('saveBtn').addEventListener('click', () => {
    const model = document.querySelector('input[name="model"]:checked')?.value || DEFAULT_MODEL;
    const ignoreList = parseLines(document.getElementById('ignoreList').value);
    const replyOnlyList = parseLines(document.getElementById('replyOnlyList').value);

    chrome.storage.local.set({ model, ignoreList, replyOnlyList }, () => {
      const status = document.getElementById('status');
      status.textContent = 'Saved.';
      setTimeout(() => { status.textContent = ''; }, 2000);
    });
  });
});
