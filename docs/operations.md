# Scrum Poker frontend operations

This repository owns the static web frontend, public protocol decoder and
types, browser E2E clients, load client, and frontend deployment checks.

## Backend ownership

The Scrum Poker API is implemented and deployed by the standalone
`all-in-one-backend` repository as the `scrum-poker` service. Backend code,
PM2, Nginx, the maintenance flag, shared-VM operations, cutover, and rollback
are owned by the standalone backend repository. The public API origin remains
`https://poker-api.keothom24.com`.

Follow `all-in-one-backend/docs/operations.md` for backend configuration and
operations. Do not run backend deployment or service commands from this
repository.

## GitHub Pages and API origin

1. In GitHub Pages settings, choose **GitHub Actions** as the source.
2. Build with `VITE_BASE_PATH=/scrum-poker/`.
3. Build with
   `VITE_API_BASE_URL=https://poker-api.keothom24.com`.
4. GitHub Actions publishes pushes to the repository; the default branch is `master`.
5. Use the canonical site URL
   `https://pltbinh.github.io/scrum-poker/` and hash routes such as
   `https://pltbinh.github.io/scrum-poker/#/room/<room-id>` so direct room
   links do not require a Pages rewrite.
6. Keep the backend CORS origin set to
   `https://pltbinh.github.io`; `/scrum-poker/` is not part of the browser
   origin.

Static assets remain on GitHub Pages. Browser traffic to the API uses ordinary
HTTP requests and native EventSource/SSE. WebSocket and Socket.IO traffic are
forbidden by `pnpm lint:no-sockets`.

## Protocol compatibility

`packages/protocol/test/fixtures/scrum-poker-wire-v1.json` is the frontend
copy of the canonical wire-v1 fixture maintained by the shared backend.
Before a frontend release, run the protocol test and confirm the fixture
continues to decode and round-trip without exposing hidden votes.

## Local and E2E checks

Install and run the frontend-owned gates:

```text
corepack pnpm install --frozen-lockfile
corepack pnpm test
corepack pnpm lint:no-sockets
corepack pnpm build
```

E2E no longer starts or controls a backend. Start an approved consolidated
backend test harness separately, configure its CORS origin for
`http://127.0.0.1:4173`, and expose a Scrum Poker-routed API URL. Then run:

```text
VITE_API_BASE_URL=http://<test-api-host>:<port> corepack pnpm test:e2e
```

`VITE_API_BASE_URL` is mandatory. The E2E clients do not default to
production and do not start, stop, or restart `all-in-one-backend`.

## SSE smoke

The smoke client creates one unique temporary room, obtains one short-lived
ticket, opens native HTTP/SSE, casts exactly one vote, observes a newer room
revision, remains connected for 300 seconds, and requires at least nine
heartbeats. It prints aggregate timing and counts only.

For the public route, after the backend owner approves the check:

```text
node deploy/scripts/smoke-sse.mjs --base-url=https://poker-api.keothom24.com
```

For a direct local shared-host check, explicitly allow HTTP and attach the
trusted local routing metadata:

```text
SMOKE_DURATION_SECONDS=5 SMOKE_MIN_HEARTBEATS=1 SMOKE_HEARTBEAT_INTERVAL_SECONDS=1 node deploy/scripts/smoke-sse.mjs --base-url=http://127.0.0.1:4000 --allow-http --app-id=scrum-poker
```

`--app-id=scrum-poker` is accepted only for loopback checks. Public requests
omit it because the standalone backend reverse proxy injects and overwrites the
trusted routing header.

Never place bearer tokens, stream tickets, authenticated stream URLs, or
credentials in commands, tickets, chat, CI logs, or deployment notes.

## Load client

The load runner remains frontend-owned and requires an explicit API origin:

```text
corepack pnpm test:load -- --base-url=http://127.0.0.1:4100 --duration-seconds=30
```

It has no production default and rejects production-looking hosts. See
`load/README.md` for the fixed 100-client shape and backend-owner
coordination requirements.
