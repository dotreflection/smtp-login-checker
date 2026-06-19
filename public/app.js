'use strict';

/* smtp-login-checker — front-end. Plain JS, no dependencies, no external calls. */

(function () {
  const form = document.getElementById('smtp-form');
  const submit = document.getElementById('submit');
  const security = document.getElementById('security');
  const port = document.getElementById('port');
  const toInput = document.getElementById('to');
  const passwordInput = document.getElementById('password');
  const togglePassword = document.getElementById('toggle-password');

  const installCmd = document.getElementById('install-cmd');

  const resultSection = document.getElementById('result');
  const statusBanner = document.getElementById('status-banner');
  const capabilities = document.getElementById('capabilities');
  const transcript = document.getElementById('transcript');
  const copyBtn = document.getElementById('copy-transcript');
  const downloadBtn = document.getElementById('download-log');

  // boot.js sets this before first paint when served from loopback. Off the
  // local machine the form can't run a check, so it is shown for design parity
  // but fully disabled (inert blocks mouse, keyboard, and focus).
  const isLocal = document.documentElement.classList.contains('is-local');
  if (!isLocal) form.inert = true;

  // Remembered from the last run, used to label a downloaded log.
  let lastMeta = null;

  // Default ports per encryption mode. We only auto-fill when the field still
  // holds a known default, so a user's custom port is never overwritten.
  const DEFAULT_PORTS = { starttls: '587', tls: '465', none: '25' };
  const KNOWN_PORTS = new Set(Object.values(DEFAULT_PORTS));

  security.addEventListener('change', () => {
    if (port.value === '' || KNOWN_PORTS.has(port.value)) {
      port.value = DEFAULT_PORTS[security.value];
    }
  });

  togglePassword.addEventListener('click', () => {
    const show = passwordInput.type === 'password';
    passwordInput.type = show ? 'text' : 'password';
    togglePassword.textContent = show ? 'Hide' : 'Show';
    togglePassword.setAttribute('aria-pressed', String(show));
    togglePassword.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });

  // One button, two modes: empty recipient -> "Test login" (auth only); a
  // recipient -> "Send test email". The label follows what the user typed.
  const idleLabel = () => (toInput.value.trim() ? 'Send test email' : 'Test login');
  const refreshButton = () => { if (!submit.disabled) submit.querySelector('.btn-label').textContent = idleLabel(); };
  toInput.addEventListener('input', refreshButton);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    run();
  });

  async function run() {
    if (!form.reportValidity()) return;
    const action = toInput.value.trim() ? 'send' : 'auth';

    const payload = {
      host: form.host.value.trim(),
      port: Number(form.port.value),
      security: form.security.value,
      username: form.username.value,
      password: form.password.value,
      action,
      to: form.to.value.trim(),
      from: form.from.value.trim(),
      authMethod: form.authMethod.value,
      verifyCert: form.verifyCert.checked,
      timeout: Math.round(Number(form.timeout.value || 15) * 1000),
    };

    // The public page has no backend; point visitors at the launch command.
    if (!isLocal) {
      showHostedGuidance();
      return;
    }

    setBusy(true, action);
    try {
      const response = await fetch('api/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json();
      if (!response.ok) {
        renderError(data.error || 'Request failed.');
      } else {
        lastMeta = { host: payload.host, port: payload.port, security: payload.security, summary: data.summary || '' };
        renderResult(data);
      }
    } catch {
      renderError('Could not reach the local checker. Is the server still running?');
    } finally {
      setBusy(false, action);
    }
  }

  // Copy-the-launch-command buttons (hero + anywhere else). Works on the hosted
  // page too, so they are wired up regardless of local/hosted.
  document.querySelectorAll('[data-copy="install"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(installCmd.textContent);
        flash(btn, 'Copied');
      } catch {
        flash(btn, 'Press Ctrl+C');
      }
    });
  });

  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(transcript.textContent);
      flash(copyBtn, 'Copied');
    } catch {
      flash(copyBtn, 'Press Ctrl+C');
    }
  });

  downloadBtn.addEventListener('click', () => {
    const log = transcript.textContent.trim();
    if (!log) {
      flash(downloadBtn, 'Nothing yet');
      return;
    }
    const stamp = timestamp();
    const host = (lastMeta && lastMeta.host) || 'smtp';
    const header = [
      'SMTP Login Checker — session log',
      lastMeta ? `Server:  ${lastMeta.host}:${lastMeta.port} (${lastMeta.security})` : '',
      `Date:    ${new Date().toISOString()}`,
      lastMeta ? `Result:  ${lastMeta.summary}` : '',
      'Note:    credential bytes are redacted; raw values never appear below.',
      '',
      '',
    ].filter((l) => l !== '').join('\n');
    downloadText(`${header}\n${log}\n`, `smtp-login-checker-${slug(host)}-${stamp}.txt`);
    flash(downloadBtn, 'Saved');
  });

  function setBusy(busy, action) {
    submit.disabled = busy;
    submit.classList.toggle('is-busy', busy);
    const label = submit.querySelector('.btn-label');
    label.textContent = busy ? (action === 'send' ? 'Sending…' : 'Testing…') : idleLabel();
  }

  function showHostedGuidance() {
    revealResult();
    capabilities.hidden = true;
    statusBanner.className = 'status-banner info';
    statusBanner.innerHTML = '';
    statusBanner.appendChild(
      bannerContent(
        'Run it on your machine to test for real',
        'This public page can’t open SMTP connections. Copy the command at the top, run it in your terminal, and the checker opens locally — then this exact form does real checks against your server.',
      ),
    );
    transcript.textContent = '';
  }

  function renderError(message) {
    revealResult();
    capabilities.hidden = true;
    statusBanner.className = 'status-banner failure';
    statusBanner.innerHTML = '';
    statusBanner.appendChild(bannerContent('Could not run the check', message));
    transcript.textContent = '';
  }

  function renderResult(data) {
    revealResult();

    const title = data.success ? (data.sent ? 'Test email sent' : 'Login successful') : 'Login failed';
    statusBanner.className = 'status-banner ' + (data.success ? 'success' : 'failure');
    statusBanner.innerHTML = '';
    statusBanner.appendChild(
      bannerContent(
        title,
        data.summary || (data.success ? 'The server accepted these credentials.' : 'The server rejected the login.'),
      ),
    );

    renderCapabilities(data);
    renderTranscript(data.steps || []);
  }

  function bannerContent(title, detail) {
    const frag = document.createDocumentFragment();
    const t = document.createElement('span');
    t.className = 'status-title';
    t.textContent = title;
    const d = document.createElement('span');
    d.className = 'status-detail';
    d.textContent = detail;
    frag.appendChild(t);
    frag.appendChild(d);
    return frag;
  }

  function renderCapabilities(data) {
    const caps = data.capabilities;
    const tls = data.tls;
    if (!caps && !tls) {
      capabilities.hidden = true;
      return;
    }
    capabilities.hidden = false;
    capabilities.innerHTML = '';

    const label = document.createElement('span');
    label.className = 'cap-label';
    label.textContent = 'Server:';
    capabilities.appendChild(label);

    if (tls && tls.protocol) capabilities.appendChild(chip(tls.protocol, true));
    if (caps && caps.starttls) capabilities.appendChild(chip('STARTTLS', true));
    if (caps && caps.auth) {
      caps.auth.forEach((mech) => capabilities.appendChild(chip('AUTH ' + mech, false)));
    }
  }

  function chip(text, on) {
    const el = document.createElement('span');
    el.className = 'chip' + (on ? ' on' : '');
    el.textContent = text;
    return el;
  }

  const TAGS = { send: 'C: ', recv: 'S: ', info: '•  ', error: '!  ', warn: '•  ' };

  function renderTranscript(steps) {
    transcript.innerHTML = '';
    steps.forEach((step) => {
      // Info lines that start with WARNING get the warning style.
      let kind = step.dir;
      if (kind === 'info' && /^warning/i.test(step.text || '')) kind = 'warn';

      const text = String(step.text || '');
      text.split('\n').forEach((rawLine, idx) => {
        const line = document.createElement('span');
        line.className = 'ln ln-' + kind;
        const tag = document.createElement('span');
        tag.className = 'tag';
        // Only the first physical line of a multi-line response carries the prefix.
        tag.textContent = idx === 0 ? (TAGS[kind] || '   ') : '   ';
        line.appendChild(tag);
        line.appendChild(document.createTextNode(rawLine));
        transcript.appendChild(line);
      });
    });
  }

  function revealResult() {
    resultSection.hidden = false;
    resultSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function downloadText(text, filename) {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function slug(value) {
    return value.replace(/[^a-zA-Z0-9.-]/g, '_').slice(0, 40) || 'smtp';
  }

  function timestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  function flash(button, text) {
    const original = button.textContent;
    button.textContent = text;
    setTimeout(() => { button.textContent = original; }, 1400);
  }
})();
