# SMTP Login Checker

A tiny, **local** tool to test SMTP credentials with a real authentication
handshake — and watch every step of the SMTP conversation. Your username and
password are sent **only** to the mail server you name; never to dotreflection
or any other third party.

Free and open source, by [dotreflection](https://dotreflection.de). Landing page:
[smtptester.dotreflection.com](https://smtptester.dotreflection.com) — it hands you
the one command below; the checker itself always runs on your own machine.

```
┌──────────┐      127.0.0.1       ┌──────────────────┐      direct SMTP      ┌─────────────┐
│ your      │ ───────────────────▶ │ smtp-login-checker│ ───────────────────▶ │ your mail    │
│ browser   │   credentials stay   │ (runs on your     │   the only outbound  │ server       │
│           │   on this machine    │  machine)         │   connection ever    │              │
└──────────┘                       └──────────────────┘                       └─────────────┘
```

## Why does it run locally?

A web page in a browser **cannot open a raw SMTP connection** — browsers only
speak HTTP and WebSockets. Any "SMTP tester" that lives purely on a website must
therefore forward your password to its own backend to perform the login, which
means trusting a stranger with working mail credentials.

This tool avoids that. You run a small program on your own computer; it serves
the page **and** performs the SMTP handshake itself. The only outbound network
connection ever made goes from your machine straight to the mail server you typed
in.

## Requirements

- [Node.js](https://nodejs.org) 18 or newer. No other dependencies — the tool
  uses only Node's built-in `net`, `tls`, `crypto`, and `http` modules.

## Run it — one command

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/dotreflection/smtp-login-checker/main/install.sh)"
```

This downloads the source into a temporary folder, starts the checker on a free
local port, and opens it in your browser. The temporary folder is deleted
automatically when you stop the tool with <kbd>Ctrl</kbd>+<kbd>C</kbd> — nothing
is installed permanently.

Prefer to pin a port? `PORT=8030 /bin/bash -c "$(curl -fsSL …/install.sh)"`.

> Read the script before running it — that's good practice for any
> `curl | bash`. It's short and lives at
> [`install.sh`](./install.sh).

## Run it — from a clone

```bash
git clone https://github.com/dotreflection/smtp-login-checker.git
cd smtp-login-checker
node server.js          # then open http://127.0.0.1:8025
```

Use a different port with `PORT=8030 node server.js`.

## What it does

1. Connects to your SMTP server (plaintext, STARTTLS, or implicit SSL/TLS).
2. Runs `EHLO`, upgrades with `STARTTLS` if requested, and reads the server's
   advertised capabilities.
3. Authenticates using `PLAIN`, `LOGIN`, or `CRAM-MD5` (auto-detected by default).
4. Reports success or the exact server rejection, with the full session
   transcript.

**No email is ever sent.** The tool authenticates, confirms the result, and
disconnects with `QUIT`.

## Privacy & security notes

- The server binds to `127.0.0.1` (loopback) only — it is not reachable from your
  network.
- Credentials are never logged, written to disk, or stored. They live only in
  memory for the duration of a single check.
- The session transcript shown in the UI **redacts** the credential bytes, so it
  is safe to copy and share when reporting a problem.
- A strict `Content-Security-Policy` forbids the page from loading or contacting
  anything other than its own origin.
- TLS certificate verification is **on** by default. You can disable it for
  servers with self-signed certificates you trust.

## License

[MIT](./LICENSE) © dotreflection
