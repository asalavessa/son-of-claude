// trigger-server.js — Son of Claude Bridge
// Local HTTP server that receives triggers from the Chrome extension
// and invokes run.sh in "session" mode (keep-alive) or "once" mode.
// Start with: node trigger-server.js

const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3000;
const COOLDOWN_MS = 10000;
const SESSION_TIMEOUT_MS = 600000; // 10 minute hard kill (covers SESSION_DURATION + overhead)
const RUN_SCRIPT = path.join(__dirname, 'run.sh');

const IDENTITY_CACHE_PATH = path.join(__dirname, 'identity-cache.json');

let activeChild = null;            // Reference to running claude process (null when idle)
let cooldownUntil = 0;             // Timestamp after which new triggers are accepted
let messageQueue = [];             // FIFO queue of enriched task objects
let processedSignatures = new Set(); // Deduplication fingerprints (capped at 500)

function loadIdentityCache() {
  try {
    return JSON.parse(fs.readFileSync(IDENTITY_CACHE_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

function saveIdentityCache(cache) {
  fs.writeFileSync(IDENTITY_CACHE_PATH, JSON.stringify(cache, null, 2));
}

function generateDeepLink(conversationId) {
  if (!conversationId) return '';
  if (conversationId.includes('@thread.v2')) {
    return `https://teams.microsoft.com/l/chat/${conversationId}/conversations`;
  }
  if (conversationId.includes('@thread.tacv2')) {
    console.log(`[${new Date().toISOString()}] Channel deep-links require tenant/group IDs — falling back to standard navigation.`);
    return '';
  }
  return '';
}

function processQueue() {
  // Guard clauses
  if (activeChild !== null) return;
  if (Date.now() < cooldownUntil) return;
  if (messageQueue.length === 0) return;

  // Prune stale messages (older than 1 hour)
  const ONE_HOUR = 3600000;
  const now = Date.now();
  messageQueue = messageQueue.filter(task => {
    if (now - task.timestamp > ONE_HOUR) {
      console.log(`[${new Date().toISOString()}] [Queue] Dropped stale message from ${task.senderName || 'unknown'}`);
      return false;
    }
    return true;
  });
  if (messageQueue.length === 0) return;

  // Peek at the oldest task to determine the target conversation
  const targetConversationId = messageQueue[0].conversationId;
  const targetSenderName = messageQueue[0].senderName;
  const model = messageQueue[0].model;
  const teamsUrl = messageQueue[0].teamsUrl;

  // Extract all messages for this conversation and remove them from the queue
  const matchingTasks = messageQueue.filter(m => m.conversationId === targetConversationId);
  messageQueue = messageQueue.filter(m => m.conversationId !== targetConversationId);

  // Combine message texts
  const combinedText = matchingTasks.map(m => m.messageText).filter(Boolean).join('\n---\n');

  // Log any unknown identities that can't be surfaced via response (we respond 202 before spawn)
  matchingTasks.forEach(t => {
    if (t.unknownIdentity) {
      console.log(`[${new Date().toISOString()}] [Queue] Unknown identity flagged for session: ${t.unknownIdentity}`);
    }
  });

  console.log(`[${new Date().toISOString()}] [Process] Starting session for ${targetSenderName || 'unknown'}. Combined ${matchingTasks.length} message(s). Queue remaining: ${messageQueue.length}`);
  if (teamsUrl) console.log(`[${new Date().toISOString()}] [Process] Deep-link: ${teamsUrl}`);

  activeChild = spawn('bash', [RUN_SCRIPT, 'session', model, teamsUrl, targetSenderName, combinedText], {
    stdio: ['ignore', 'inherit', 'inherit']
  });

  // Hard kill safety net
  const killTimer = setTimeout(() => {
    console.log(`[${new Date().toISOString()}] Session exceeded ${SESSION_TIMEOUT_MS / 60000} minute timeout. Killing process.`);
    activeChild.kill('SIGTERM');
  }, SESSION_TIMEOUT_MS);

  activeChild.on('close', (code) => {
    clearTimeout(killTimer);
    activeChild = null;
    cooldownUntil = Date.now() + COOLDOWN_MS;
    console.log(`[${new Date().toISOString()}] Session finished (exit ${code}). Cooldown ${COOLDOWN_MS / 1000}s...`);
    setTimeout(() => {
      console.log(`[${new Date().toISOString()}] [Queue] Cooldown complete. Checking for pending tasks...`);
      processQueue();
    }, COOLDOWN_MS);
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // --- Identity management endpoints ---
  if (req.url === '/identities' && req.method === 'GET') {
    const cache = loadIdentityCache();
    const rows = Object.entries(cache).map(([id, name]) =>
      `<tr><td>${id}</td><td><input value="${name}" data-id="${id}"></td><td><button onclick="del('${id}')">X</button></td></tr>`
    ).join('');
    const html = `<!DOCTYPE html><html><head><title>Son of Claude — Identity Cache</title>
<style>body{font-family:sans-serif;max-width:800px;margin:2em auto}table{width:100%;border-collapse:collapse}
td,th{border:1px solid #ccc;padding:8px;text-align:left}input{width:90%}button{cursor:pointer}
#status{margin-top:1em;color:green}</style></head><body>
<h1>Identity Cache</h1>
<table><tr><th>Entra ID</th><th>Display Name</th><th></th></tr>${rows}
<tr><td><input id="newId" placeholder="Entra ID"></td><td><input id="newName" placeholder="Display Name"></td>
<td><button onclick="add()">Add</button></td></tr></table>
<button onclick="save()">Save All</button><div id="status"></div>
<script>
function save(){const inputs=document.querySelectorAll('input[data-id]');
inputs.forEach(i=>{fetch('/identities',{method:'POST',headers:{'Content-Type':'application/json'},
body:JSON.stringify({id:i.dataset.id,name:i.value})})});document.getElementById('status').textContent='Saved!'}
function add(){const id=document.getElementById('newId').value,name=document.getElementById('newName').value;
if(!id)return;fetch('/identities',{method:'POST',headers:{'Content-Type':'application/json'},
body:JSON.stringify({id,name})}).then(()=>location.reload())}
function del(id){fetch('/identities',{method:'POST',headers:{'Content-Type':'application/json'},
body:JSON.stringify({id,name:null})}).then(()=>location.reload())}
</script></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
    return;
  }

  if (req.url === '/identities' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        const { id, name } = JSON.parse(body);
        const cache = loadIdentityCache();
        if (name === null) {
          delete cache[id];
        } else {
          cache[id] = name;
        }
        saveIdentityCache(cache);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } catch (_) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'error' }));
      }
    });
    return;
  }

  // --- Session status endpoint ---
  if (req.url === '/status' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ active: !!activeChild, queueLength: messageQueue.length }));
    return;
  }

  if (req.url !== '/trigger' || req.method !== 'POST') {
    res.writeHead(404);
    res.end();
    return;
  }

  // Post-session cooldown (prevents post-session burst from flooding the queue)
  if (Date.now() < cooldownUntil) {
    console.log(`[${new Date().toISOString()}] Trigger ignored — in cooldown.`);
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ignored', reason: 'cooldown' }));
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body); } catch (_) {}

    const model = payload.model || 'claude-sonnet-4-6';
    const messageText = payload.messageText || '';
    const messageCount = payload.messageCount || (messageText ? 1 : 0);
    const conversationId = payload.conversationId || '';
    const replyToId = payload.replyToId || '';
    const senderId = payload.senderId || '';
    let senderName = payload.senderName || '';

    // Identity cache lookup: resolve senderId if senderName is missing
    let unknownIdentity = null;
    if (!senderName && senderId) {
      const cache = loadIdentityCache();
      if (cache[senderId]) {
        senderName = cache[senderId];
        console.log(`[${new Date().toISOString()}] Resolved senderId ${senderId} to "${senderName}" via identity cache.`);
      } else {
        console.log(`[${new Date().toISOString()}] WARNING: Unknown senderId ${senderId} — not in identity cache. Proceeding with null (fail-open).`);
        unknownIdentity = senderId;
      }
    }

    // Smart deep-link generation
    const teamsUrl = generateDeepLink(conversationId) || payload.source || '';

    // Deduplication check
    const signature = `${conversationId}|${senderName}|${messageText}`;
    if (processedSignatures.has(signature)) {
      console.log(`[${new Date().toISOString()}] [Queue] Dropped duplicate from ${senderName || 'unknown'}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ignored_duplicate' }));
      return;
    }
    processedSignatures.add(signature);
    if (processedSignatures.size > 500) {
      processedSignatures.delete(processedSignatures.values().next().value);
    }

    // Push to queue
    messageQueue.push({
      timestamp: Date.now(),
      senderName,
      senderId,
      model,
      teamsUrl,
      messageText,
      messageCount,
      conversationId,
      replyToId,
      unknownIdentity
    });

    console.log(`[${new Date().toISOString()}] [Queue] Added from ${senderName || 'unknown'}. Queue length: ${messageQueue.length}`);
    if (messageText) console.log(`[${new Date().toISOString()}] Message text (${messageCount} msg${messageCount > 1 ? 's' : ''}): ${messageText.substring(0, 200)}${messageText.length > 200 ? '...' : ''}`);

    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'queued', queueLength: messageQueue.length }));

    processQueue();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[${new Date().toISOString()}] Son of Claude Bridge running at http://127.0.0.1:${PORT}`);
  console.log(`Listening for triggers from the Chrome extension...`);
});

function shutdown(signal) {
  console.log(`\n[${new Date().toISOString()}] ${signal} received. Shutting down...`);
  if (activeChild) {
    console.log(`[${new Date().toISOString()}] Killing active Claude session...`);
    activeChild.kill('SIGTERM');
  }
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
