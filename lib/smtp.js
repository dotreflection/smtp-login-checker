'use strict';

/**
 * Minimal, dependency-free SMTP authentication client.
 *
 * It performs a real SMTP handshake (connect → EHLO → optional STARTTLS →
 * AUTH → QUIT) and returns a structured transcript of every step so the UI can
 * show exactly what happened. Credentials are only ever sent to the SMTP server
 * the caller specified; they are base64-encoded into the AUTH exchange and the
 * raw values are never written to the returned transcript.
 */

const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const os = require('os');

const CRLF = '\r\n';

/** Resolve once `event` fires; reject on error / premature close. */
function awaitEvent(emitter, event) {
  return new Promise((resolve, reject) => {
    const onEvent = (value) => { cleanup(); resolve(value); };
    const onError = (err) => { cleanup(); reject(err); };
    const onClose = () => { cleanup(); reject(new Error(`Connection closed before "${event}"`)); };
    function cleanup() {
      emitter.removeListener(event, onEvent);
      emitter.removeListener('error', onError);
      emitter.removeListener('close', onClose);
    }
    emitter.on(event, onEvent);
    emitter.on('error', onError);
    emitter.on('close', onClose);
  });
}

/**
 * Wraps a socket and yields complete SMTP responses. A response can span
 * several lines ("250-FOO" continuation lines, terminated by a "250 BAR" line).
 */
function createReader(socket) {
  let buffer = '';
  let pending = null; // { resolve, reject }
  let failure = null;

  const onData = (chunk) => { buffer += chunk.toString('utf8'); flush(); };
  const onError = (err) => { failure = err; if (pending) { pending.reject(err); pending = null; } };
  const onClose = () => onError(new Error('Connection closed by server'));

  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('close', onClose);

  function parse() {
    const lines = buffer.split(CRLF);
    for (let i = 0; i < lines.length; i++) {
      // A final line is "NNN<space>"; continuation lines are "NNN-".
      if (/^\d{3} /.test(lines[i])) {
        const used = lines.slice(0, i + 1);
        const consumed = used.join(CRLF) + CRLF;
        buffer = buffer.slice(consumed.length);
        const code = parseInt(used[i].slice(0, 3), 10);
        const text = used.map((l) => l.slice(4)).join('\n');
        return { code, text, raw: used.join('\n') };
      }
    }
    return null;
  }

  function flush() {
    if (!pending) return;
    const response = parse();
    if (response) { const p = pending; pending = null; p.resolve(response); }
  }

  return {
    read() {
      if (failure) return Promise.reject(failure);
      return new Promise((resolve, reject) => { pending = { resolve, reject }; flush(); });
    },
    /** Stop reading and hand back any unconsumed bytes (needed before STARTTLS). */
    detach() {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      return buffer;
    },
  };
}

function base64(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

/** A friendly EHLO identity that does not leak more than a normal mail client. */
function clientName() {
  const host = (os.hostname() || 'localhost').replace(/[^a-zA-Z0-9.-]/g, '');
  return host || 'localhost';
}

const TEST_SUBJECT = 'SMTP Login Checker test message';

/** RFC 5322 date, e.g. "Fri, 19 Jun 2026 13:05:11 +0000". */
function rfc5322Date() {
  return new Date().toUTCString().replace('GMT', '+0000');
}

/** Build a small, self-explanatory plain-text test email with CRLF endings. */
function buildTestMessage({ from, to, username, host }) {
  const id = `${crypto.randomBytes(10).toString('hex')}@smtp-login-checker`;
  const headers = [
    `Date: ${rfc5322Date()}`,
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${TEST_SUBJECT}`,
    `Message-ID: <${id}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    'Auto-Submitted: auto-generated',
    'X-Mailer: smtp-login-checker',
  ];
  const safeUser = String(username).replace(/[\r\n]+/g, ' ');
  const body = [
    'This is a test message from SMTP Login Checker.',
    '',
    `It confirms that "${safeUser}" can authenticate and send mail through ${host}.`,
    'If you received it, sending works. Nothing else was done.',
    '',
    'https://smtptester.dotreflection.com',
  ];
  return headers.join(CRLF) + CRLF + CRLF + body.join(CRLF);
}

/** SMTP dot-stuffing: a line that begins with "." gets an extra leading ".". */
function dotStuff(message) {
  return message
    .split(CRLF)
    .map((line) => (line.startsWith('.') ? '.' + line : line))
    .join(CRLF);
}

/** Open a plaintext TCP socket. */
async function connectPlain(host, port, timeout) {
  const socket = net.connect({ host, port });
  socket.setTimeout(timeout, () => socket.destroy(new Error(`Timed out after ${timeout} ms`)));
  await awaitEvent(socket, 'connect');
  return socket;
}

/** Open (or upgrade to) a TLS socket. Pass `socket` to upgrade an existing one. */
async function connectTls(options, timeout) {
  const socket = tls.connect({ ...options, timeout });
  socket.setTimeout(timeout, () => socket.destroy(new Error(`Timed out after ${timeout} ms`)));
  await awaitEvent(socket, 'secureConnect');
  return socket;
}

function tlsInfo(socket) {
  if (typeof socket.getProtocol !== 'function' || !socket.encrypted) return null;
  const cipher = socket.getCipher ? socket.getCipher() : null;
  return {
    protocol: socket.getProtocol(),
    cipher: cipher ? cipher.name : null,
    authorized: socket.authorized,
    authorizationError: socket.authorizationError ? String(socket.authorizationError) : null,
  };
}

/** Parse AUTH mechanisms and STARTTLS support out of an EHLO response. */
function parseCapabilities(ehloText) {
  const lines = ehloText.split('\n').map((l) => l.trim().toUpperCase());
  let auth = [];
  let starttls = false;
  for (const line of lines) {
    if (line === 'STARTTLS') starttls = true;
    if (line.startsWith('AUTH ') || line.startsWith('AUTH=')) {
      auth = auth.concat(line.slice(5).split(/[\s=]+/).filter(Boolean));
    }
  }
  return { auth: [...new Set(auth)], starttls, raw: ehloText.split('\n') };
}

function chooseMechanism(requested, available) {
  const supported = ['PLAIN', 'LOGIN', 'CRAM-MD5'];
  if (requested && requested !== 'auto') {
    const wanted = requested.toUpperCase();
    if (!supported.includes(wanted)) throw new Error(`Unsupported auth mechanism: ${requested}`);
    return wanted;
  }
  // Auto: mirror what real mail clients do, for the most predictable result.
  // LOGIN/PLAIN are the most universally implemented; CRAM-MD5 is a fallback.
  const preference = ['LOGIN', 'PLAIN', 'CRAM-MD5'];
  const offered = available.map((a) => a.toUpperCase());
  for (const mech of preference) {
    if (offered.includes(mech)) return mech;
  }
  // Server advertised no mechanism we recognise — fall back to PLAIN and let it fail loudly.
  return 'PLAIN';
}

/**
 * Run a full SMTP auth check.
 *
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} opts.port
 * @param {'tls'|'starttls'|'none'} opts.security
 * @param {string} opts.username
 * @param {string} opts.password
 * @param {'auto'|'plain'|'login'|'cram-md5'} [opts.authMethod]
 * @param {boolean} [opts.verifyCert]
 * @param {number} [opts.timeout]
 * @returns {Promise<object>} structured result with a step-by-step transcript
 */
async function check(opts) {
  const timeout = Math.min(Math.max(Number(opts.timeout) || 15000, 1000), 60000);
  const verifyCert = opts.verifyCert !== false;
  const steps = [];
  const info = (text) => steps.push({ dir: 'info', text });
  const sent = (text) => steps.push({ dir: 'send', text });
  const recv = (response) => steps.push({ dir: 'recv', text: response.raw, code: response.code });

  let socket;
  let reader;
  const result = {
    success: false,
    summary: '',
    steps,
    capabilities: null,
    tls: null,
    meta: { host: opts.host, port: opts.port, security: opts.security },
  };

  // Helper: send a command and read one response, asserting an expected code.
  async function exchange(command, expected, { display } = {}) {
    sent(display || command);
    socket.write(command + CRLF);
    const response = await reader.read();
    recv(response);
    if (expected && !expected.includes(response.code)) {
      const err = new Error(`Server replied ${response.code} (expected ${expected.join('/')})`);
      err.response = response;
      throw err;
    }
    return response;
  }

  try {
    // 1. Connect ----------------------------------------------------------
    const implicitTls = opts.security === 'tls';
    info(`Connecting to ${opts.host}:${opts.port} (${implicitTls ? 'implicit TLS' : 'plaintext'})`);
    if (implicitTls) {
      socket = await connectTls({ host: opts.host, port: opts.port, servername: opts.host, rejectUnauthorized: verifyCert }, timeout);
      result.tls = tlsInfo(socket);
      info(`TLS established: ${result.tls.protocol}, ${result.tls.cipher}`);
    } else {
      socket = await connectPlain(opts.host, opts.port, timeout);
    }
    reader = createReader(socket);

    // 2. Greeting + EHLO --------------------------------------------------
    const greeting = await reader.read();
    recv(greeting);
    if (greeting.code !== 220) throw withResponse(`Server did not send a 220 greeting (got ${greeting.code})`, greeting);

    let ehlo = await exchange(`EHLO ${clientName()}`, [250]);
    let caps = parseCapabilities(ehlo.text);

    // 3. STARTTLS upgrade -------------------------------------------------
    if (opts.security === 'starttls') {
      if (!caps.starttls) throw new Error('Server does not advertise STARTTLS on this port.');
      await exchange('STARTTLS', [220]);
      const leftover = reader.detach();
      if (leftover) socket.unshift(Buffer.from(leftover, 'utf8'));
      socket = await connectTls({ socket, servername: opts.host, rejectUnauthorized: verifyCert }, timeout);
      result.tls = tlsInfo(socket);
      info(`TLS established: ${result.tls.protocol}, ${result.tls.cipher}`);
      reader = createReader(socket);
      ehlo = await exchange(`EHLO ${clientName()}`, [250]); // re-EHLO inside the TLS session
      caps = parseCapabilities(ehlo.text);
    }
    result.capabilities = caps;

    // 4. Warn if credentials would travel in cleartext --------------------
    const encrypted = Boolean(result.tls);
    if (!encrypted) {
      info('WARNING: connection is not encrypted — credentials would be sent in cleartext.');
    }

    // 5. AUTH -------------------------------------------------------------
    if (caps.auth.length === 0) {
      info('Server advertised no AUTH mechanisms; attempting anyway.');
    }
    const mechanism = chooseMechanism(opts.authMethod, caps.auth);
    info(`Authenticating with ${mechanism} as "${opts.username}"`);

    if (mechanism === 'PLAIN') {
      const token = base64(`\0${opts.username}\0${opts.password}`);
      await exchange(`AUTH PLAIN ${token}`, [235], { display: 'AUTH PLAIN ********  (credentials redacted)' });
    } else if (mechanism === 'LOGIN') {
      await exchange('AUTH LOGIN', [334]);
      await exchange(base64(opts.username), [334], { display: '<base64 username, redacted>' });
      await exchange(base64(opts.password), [235], { display: '<base64 password, redacted>' });
    } else if (mechanism === 'CRAM-MD5') {
      const challengeResp = await exchange('AUTH CRAM-MD5', [334]);
      const challenge = Buffer.from(challengeResp.text.trim(), 'base64').toString('utf8');
      const digest = crypto.createHmac('md5', opts.password).update(challenge).digest('hex');
      const answer = base64(`${opts.username} ${digest}`);
      await exchange(answer, [235], { display: '<base64 HMAC-MD5 response, redacted>' });
    }

    // 6. Success ----------------------------------------------------------
    result.success = true;
    result.summary = `Authentication succeeded for "${opts.username}" via ${mechanism}.`;
    info('Authentication accepted (235).');

    // 7. Optionally send a test email -------------------------------------
    if (opts.action === 'send') {
      const from = opts.from || opts.username;
      const to = opts.to;
      info(`Sending a test email from "${from}" to "${to}"`);
      await exchange(`MAIL FROM:<${from}>`, [250]);
      await exchange(`RCPT TO:<${to}>`, [250, 251]);
      await exchange('DATA', [354]);

      const message = buildTestMessage({ from, to, username: opts.username, host: opts.host });
      const lineCount = message.split(CRLF).length;
      sent(`[test message: ${lineCount} lines, subject "${TEST_SUBJECT}"]`);
      socket.write(dotStuff(message) + CRLF + '.' + CRLF);
      const dataResp = await reader.read();
      recv(dataResp);
      if (dataResp.code !== 250) throw withResponse(`Server rejected the message (${dataResp.code})`, dataResp);

      result.sent = true;
      result.summary = `Authentication succeeded and a test email was sent to "${to}".`;
      info('Test email accepted by the server.');
    }

    // 8. Politely close ---------------------------------------------------
    try { await exchange('QUIT', [221]); } catch { /* server may just drop the connection */ }
  } catch (err) {
    result.success = false;
    result.error = friendlyError(err);
    result.summary = result.error;
    steps.push({ dir: 'error', text: result.error });
  } finally {
    if (socket) socket.destroy();
  }

  return result;
}

function withResponse(message, response) {
  const err = new Error(message);
  err.response = response;
  return err;
}

/** Turn low-level socket/TLS errors into something a human can act on. */
function friendlyError(err) {
  const code = err && err.code;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Host not found: ${err.hostname || ''}`.trim();
  if (code === 'ECONNREFUSED') return 'Connection refused — check the host and port.';
  if (code === 'ETIMEDOUT' || /Timed out/.test(err.message)) return 'Connection timed out — the server did not respond.';
  if (code === 'ECONNRESET') return 'Connection reset by the server (often a TLS/port mismatch).';
  if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN') {
    return 'TLS certificate is self-signed. Re-run with certificate verification disabled if you trust this server.';
  }
  if (code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'CERT_HAS_EXPIRED' || (code && code.includes('CERT'))) {
    return `TLS certificate could not be verified (${code}). Disable certificate verification if you trust this server.`;
  }
  if (err && err.response) return `${err.message}: ${err.response.raw}`;
  return (err && err.message) || 'Unknown error';
}

module.exports = { check };
