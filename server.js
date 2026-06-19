#!/usr/bin/env node
'use strict';

/**
 * smtp-login-checker — a local, zero-dependency tool to test SMTP credentials.
 *
 * The server binds to loopback only and does two things:
 *   1. Serves the static UI from ./public
 *   2. Exposes POST /api/check, which runs a real SMTP auth handshake
 *
 * Credentials POSTed by the browser are used solely to talk to the SMTP server
 * the user named. They are never logged, stored, or sent anywhere else.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const smtp = require('./lib/smtp');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 8025;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 64 * 1024; // generous for a form, small enough to refuse abuse

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

// A strict CSP: the page may only talk to its own origin and may not pull in any
// third-party resource. This is part of the trust story and is easy to verify.
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function send(res, status, headers, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, { 'Content-Type': 'application/json; charset=utf-8' }, JSON.stringify(payload));
}

function serveStatic(req, res) {
  const urlPath = req.url.split('?')[0];
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);

  // Prevent path traversal: the resolved path must stay inside PUBLIC_DIR.
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    return send(res, 403, { 'Content-Type': 'text/plain' }, 'Forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, { 'Content-Type': 'text/plain' }, 'Not found');
    const ext = path.extname(filePath).toLowerCase();
    send(res, 200, { 'Content-Type': MIME[ext] || 'application/octet-stream' }, data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY) {
        reject(new Error('Request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

// A deliberately conservative address check. Anything that could break out of a
// "MAIL FROM:<...>" command or inject a mail header (CRLF, spaces, angle
// brackets) is rejected — this is the SMTP-injection guard, not RFC 5321 parsing.
function isSafeAddress(value) {
  return /^[^\s<>"@]+@[^\s<>"@]+\.[^\s<>"@]+$/.test(value);
}

function validate(payload) {
  const errors = [];
  const host = String(payload.host || '').trim();
  const port = Number(payload.port);
  const security = String(payload.security || '').toLowerCase();
  const username = String(payload.username || '');
  const password = String(payload.password || '');
  const action = String(payload.action || 'auth').toLowerCase();
  const to = String(payload.to || '').trim();
  const from = String(payload.from || '').trim();

  if (!host || /[\s/\\]/.test(host)) errors.push('A valid host is required.');
  if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('Port must be between 1 and 65535.');
  if (!['tls', 'starttls', 'none'].includes(security)) errors.push('Security must be tls, starttls or none.');
  if (!username) errors.push('Username is required.');
  if (!password) errors.push('Password is required.');
  if (!['auth', 'send'].includes(action)) errors.push('Action must be auth or send.');

  if (action === 'send') {
    if (!to) errors.push('A recipient is required to send a test email.');
    else if (!isSafeAddress(to)) errors.push('The recipient address looks invalid.');
    // The envelope sender defaults to the username, so the effective From must
    // be a valid address too (and never carry CRLF into the MAIL FROM command).
    const effectiveFrom = from || username;
    if (!isSafeAddress(effectiveFrom)) {
      errors.push('To send mail, set a valid From address (the username is not a usable email).');
    }
  }

  return {
    errors,
    value: {
      host,
      port,
      security,
      username,
      password,
      action,
      to,
      from,
      authMethod: String(payload.authMethod || 'auto').toLowerCase(),
      verifyCert: payload.verifyCert !== false,
      timeout: Number(payload.timeout) || 15000,
    },
  };
}

async function handleCheck(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON body.' });
  }

  const { errors, value } = validate(payload);
  if (errors.length) return sendJson(res, 400, { error: errors.join(' ') });

  try {
    const result = await smtp.check(value);
    sendJson(res, 200, result);
  } catch (err) {
    // Unexpected failures still return 200 with success:false so the UI can render them.
    sendJson(res, 200, { success: false, summary: String(err.message || err), steps: [] });
  }
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/check') return handleCheck(req, res);
  if (req.method === 'GET') return serveStatic(req, res);
  send(res, 405, { 'Content-Type': 'text/plain', Allow: 'GET, POST' }, 'Method not allowed');
});

server.listen(PORT, HOST, () => {
  const url = `http://${HOST}:${PORT}`;
  process.stdout.write(
    `\n  smtp-login-checker is running locally.\n\n` +
      `  Open:        ${url}\n` +
      `  Privacy:     bound to ${HOST} only — nothing is sent to dotreflection or any third party.\n` +
      `  Source:      https://github.com/dotreflection/smtp-login-checker\n\n` +
      `  Press Ctrl+C to stop.\n\n`,
  );
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    process.stderr.write(`\n  Port ${PORT} is already in use. Try: PORT=8030 node server.js\n\n`);
    process.exit(1);
  }
  throw err;
});
