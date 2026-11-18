# Security policy

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Report them privately through GitHub's *Security → Report a vulnerability* on this repository (private vulnerability reporting). Include what you found, how to reproduce it, and the impact you expect.

We aim to acknowledge reports within a few days and to fix confirmed issues promptly. Please give us reasonable time to release a fix before disclosing details.

## Supported versions

Synqonix has no stable releases yet; fixes land on `main`.

## What is in place

Authorization checks on every route (covered by an automated route matrix), nonce-based Content-Security-Policy on the web app, rate limiting, HMAC-signed webhooks with SSRF protection for outbound ones, private S3 buckets accessed only through short-lived presigned links, production secret checks at boot, and dependency audit and secret scanning in CI.

## Known limitations

- **GitHub App installation:** connecting an installation requires the person to administer it on GitHub (account owner, or organization owner), checked through GitHub's own authorization during installation. The GitHub App must have "Request user authorization (OAuth) during installation" enabled and the organization permission "Members: read" (see [docs/github-integration.md](docs/github-integration.md)).
- Access tokens are stored in the browser's `localStorage` (the strict CSP is the mitigation); the refresh token is also returned to non-browser clients.
- Running more than one API instance requires `REDIS_URL` (shared Socket.IO adapter, rate limits and scheduled jobs). Without it, realtime and schedulers assume a single process.
