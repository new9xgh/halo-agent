# halo web-demo

Standalone browser frontend for the halo web channel. An Express proxy holds
the `HALO_TOKEN` server-side; the browser authenticates with a password and
never sees the token. Full design notes: `.halo/docs/design/web.md`.

## Run

```bash
HALO_API=http://localhost:9527 \
HALO_TOKEN=<web-channel token from the admin panel> \
HALO_WEB_DEMO_PASSWORD=<login password, empty = open access> \
node server.js   # listens on :9528 (PORT to override)
```

## Deployment notes

- **Put it behind a trusted reverse proxy.** Login brute-force lockout keys on
  the first `x-forwarded-for` hop. When the port is exposed directly, a client
  can forge that header to dodge the lockout — or lock out someone else's IP.
  Only a proxy you control (nginx / caddy / ALB) that overwrites
  `x-forwarded-for` makes the lockout meaningful.
- **Direct-connect mode stores the token in the browser.** The gear panel's
  opt-in direct mode keeps the web-channel token in that browser's
  localStorage, where any XSS on the page could read it. Use it only from
  trusted devices/environments; proxy mode (the default) never exposes the
  token to the browser.
