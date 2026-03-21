// trigger-server.js — Son of Claude Bridge
// Local HTTP server that receives triggers from the Chrome extension
// and invokes run.sh in "session" mode (keep-alive) or "once" mode.
// Start with: node trigger-server.js

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3000;
const COOLDOWN_MS = 10000; // Short cooldown — activeChild tracking prevents double-spawning
const SESSION_TIMEOUT_MS = 600000; // 10 minute hard kill (covers SESSION_DURATION + overhead)
const RUN_SCRIPT = path.join(__dirname, 'run.sh');

let activeChild = null;   // Reference to running claude process (null when idle)
let cooldownUntil = 0;    // Timestamp after which new triggers are accepted

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url !== '/trigger' || req.method !== 'POST') {
    res.writeHead(404);
    res.end();
    return;
  }

  // If a session is actively running, ignore the trigger — the session loop handles follow-ups
  if (activeChild) {
    console.log(`[${new Date().toISOString()}] Trigger ignored — session already active.`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'active_session_exists' }));
    return;
  }

  // Post-session cooldown (prevents immediate re-trigger after session ends)
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
    console.log(`[${new Date().toISOString()}] Activity detected. Sender: ${payload.senderName || 'unknown'}, Model: ${model}`);
    console.log(`[${new Date().toISOString()}] Starting session...`);

    activeChild = spawn('bash', [RUN_SCRIPT, 'session', model], {
      stdio: ['ignore', 'inherit', 'inherit']
    });

    // Hard kill safety net — covers SESSION_DURATION + per-pass overhead
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
        console.log(`[${new Date().toISOString()}] Ready for next trigger.`);
      }, COOLDOWN_MS);
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'session_started', timestamp: new Date().toISOString() }));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[${new Date().toISOString()}] Son of Claude Bridge running at http://127.0.0.1:${PORT}`);
  console.log(`Listening for triggers from the Chrome extension...`);
});
