# SSE load client

`pnpm test:load -- --base-url=http://127.0.0.1:4100` runs the HTTP/SSE
client against an explicit, locally routed Scrum Poker API. The client never
starts a backend, never defaults to a URL, rejects malformed values, and
refuses production-looking hosts such as
`https://poker-api.keothom24.com`.

The backend and its test harness are owned by `keothom/be`. Start an approved
local `all-in-one-backend` harness separately and route the supplied URL to
the `scrum-poker` service before running this client. Direct shared-host
requests require the trusted `X-Backend-App: scrum-poker` metadata, so use
the KeoThom-owned local proxy or test harness rather than pointing this client
at an unrouted shared-host port.

The load shape is fixed at 5 rooms by 20 participants: 100 concurrent SSE
clients. The runner:

- creates the same rooms and participants as the browser;
- requests one short-lived stream ticket per participant;
- opens 100 native `text/event-stream` connections;
- waits for all initial snapshots;
- casts representative votes, reveals, and resets every room;
- keeps streams open for the configured duration;
- fails on partial setup or excess unexpected disconnects; and
- logs aggregate counts only, never credentials or authenticated URLs.

`--allowed-unexpected-disconnects` is an inclusive non-negative allowance
and defaults to `0`.

## Local 30-second check

After the backend owner provides a routed loopback API URL:

```text
corepack pnpm test:load -- --base-url=http://127.0.0.1:4100 --duration-seconds=30
```

## Five-minute observation gate

Running load against production requires explicit approval and is not part of
repository verification. Coordinate the 300-second observation with the
KeoThom backend owner and follow
`keothom/docs/all-in-one-backend-operations.md` for process RSS, restart
counters, available memory, and rollback criteria. This repository does not
own PM2, Nginx, VM state, or backend lifecycle operations.
