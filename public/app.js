'use strict';

/* smtp-login-checker — front-end. Plain JS, no dependencies, no external calls. */

(function () {
  const form = document.getElementById('smtp-form');
  const submit = document.getElementById('submit');
  const security = document.getElementById('security');
  const port = document.getElementById('port');
  const passwordInput = document.getElementById('password');
  const togglePassword = document.getElementById('toggle-password');

  const installCmd = document.getElementById('install-cmd');

  const resultSection = document.getElementById('result');
  const statusBanner = document.getElementById('status-banner');
  const capabilities = document.getElementById('capabilities');
  const transcript = document.getElementById('transcript');
  const copyBtn = document.getElementById('copy-transcript');

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

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    const payload = {
      host: form.host.value.trim(),
      port: Number(form.port.value),
      security: form.security.value,
      username: form.username.value,
      password: form.password.value,
      authMethod: form.authMethod.value,
      verifyCert: form.verifyCert.checked,
      timeout: Math.round(Number(form.timeout.value || 15) * 1000),
    };

    setBusy(true);
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
        renderResult(data);
      }
    } catch (err) {
      renderError('Could not reach the local checker. Is the server still running?');
    } finally {
      setBusy(false);
    }
  });

  // Copy-the-launch-command buttons (hero + landing notice). These work on the
  // hosted landing page too, so they are wired up regardless of local/hosted.
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

  function setBusy(busy) {
    submit.disabled = busy;
    submit.classList.toggle('is-busy', busy);
    submit.querySelector('.btn-label').textContent = busy ? 'Testing…' : 'Test login';
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

    statusBanner.className = 'status-banner ' + (data.success ? 'success' : 'failure');
    statusBanner.innerHTML = '';
    statusBanner.appendChild(
      bannerContent(
        data.success ? 'Login successful' : 'Login failed',
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

  function flash(button, text) {
    const original = button.textContent;
    button.textContent = text;
    setTimeout(() => { button.textContent = original; }, 1400);
  }
})();
