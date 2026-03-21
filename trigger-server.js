// trigger-server.js — Son of Claude Bridge
// Local HTTP server that receives triggers from the Chrome extension
// and invokes run.sh in "once" mode.
// Start with: node trigger-server.js

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3000;
const COOLDOWN_MS = 30000;
const RUN_SCRIPT = path.join(__dirname, 'run.sh');

let isProcessing = false;

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

  if (isProcessing) {
    console.log(`[${new Date().toISOString()}] Trigger ignored — already processing or in cooldown.`);
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ignored', reason: 'already_processing' }));
    return;
  }

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    let payload = {};
    try { payload = JSON.parse(body); } catch (_) {}

    const model = payload.model || 'claude-sonnet-4-6';
    console.log(`[${new Date().toISOString()}] Activity detected. Type: ${payload.type || 'unknown'}, Sender: ${payload.senderName || 'unknown'}, Model: ${model}`);
    console.log(`[${new Date().toISOString()}] Triggering Claude...`);

    isProcessing = true;

    const claude = spawn('bash', [RUN_SCRIPT, 'once', model], {
      stdio: ['ignore', 'inherit', 'inherit']  // close stdin so Claude knows it's non-interactive
    });

    // Safety net: kill the process if it runs longer than 5 minutes
    const killTimer = setTimeout(() => {
      console.log(`[${new Date().toISOString()}] Claude exceeded 5 minute timeout. Killing process.`);
      claude.kill('SIGTERM');
    }, 300000);

    claude.on('close', (code) => {
      clearTimeout(killTimer);
      console.log(`[${new Date().toISOString()}] Claude session finished (exit ${code}). Cooldown ${COOLDOWN_MS / 1000}s...`);
      setTimeout(() => {
        isProcessing = false;
        console.log(`[${new Date().toISOString()}] Ready for next trigger.`);
      }, COOLDOWN_MS);
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'triggered', timestamp: new Date().toISOString() }));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[${new Date().toISOString()}] Son of Claude Bridge running at http://127.0.0.1:${PORT}`);
  console.log(`Listening for triggers from the Chrome extension...`);
});
