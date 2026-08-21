#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import http from "node:http";
import https from "node:https";

const PRODUCTION_DURATION_SECONDS = 300;
const PRODUCTION_MIN_HEARTBEATS = 9;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

function usage() {
  console.error(
    "Usage: node deploy/scripts/smoke-sse.mjs --base-url=<https-url> [--allow-http] [--app-id=scrum-poker] " +
      "[--duration-seconds=<seconds>] [--min-heartbeats=<count>]",
  );
}

function parsePositiveInteger(value, name, { allowZero = false } = {}) {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${name} must be a ${allowZero ? "non-negative" : "positive"} integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || (!allowZero && parsed <= 0)) {
    throw new Error(`${name} is out of range`);
  }

  return parsed;
}

function parseOptions(argv) {
  let baseUrl;
  let appId;
  let allowHttp = false;
  let durationSeconds = process.env.SMOKE_DURATION_SECONDS ?? String(PRODUCTION_DURATION_SECONDS);
  let minHeartbeats = process.env.SMOKE_MIN_HEARTBEATS ?? String(PRODUCTION_MIN_HEARTBEATS);
  let heartbeatIntervalSeconds = process.env.SMOKE_HEARTBEAT_INTERVAL_SECONDS ?? "30";

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--allow-http") {
      allowHttp = true;
      continue;
    }

    if (argument === "--help") {
      usage();
      process.exit(0);
    }

    const [name, inlineValue] = argument.split("=", 2);
    const value = inlineValue ?? argv[++index];

    if (value === undefined) {
      throw new Error(`${name} requires a value`);
    }

    if (name === "--base-url") {
      baseUrl = value;
    } else if (name === "--app-id") {
      appId = value;
    } else if (name === "--duration-seconds") {
      durationSeconds = value;
    } else if (name === "--min-heartbeats") {
      minHeartbeats = value;
    } else if (name === "--heartbeat-interval-seconds") {
      heartbeatIntervalSeconds = value;
    } else {
      throw new Error(`unknown option ${name}`);
    }
  }

  if (baseUrl === undefined) {
    throw new Error("--base-url is required");
  }

  const parsedBaseUrl = new URL(baseUrl);
  if (parsedBaseUrl.username || parsedBaseUrl.password) {
    throw new Error("base URL must not contain credentials");
  }

  if (parsedBaseUrl.protocol !== "https:" && !allowHttp) {
    throw new Error("refusing non-HTTPS base URL; pass --allow-http for an explicit local check");
  }

  if (parsedBaseUrl.search || parsedBaseUrl.hash) {
    throw new Error("base URL must not contain a query string or fragment");
  }

  if (appId !== undefined && appId !== "scrum-poker") {
    throw new Error("--app-id must be scrum-poker");
  }

  if (appId !== undefined && !LOOPBACK_HOSTNAMES.has(parsedBaseUrl.hostname)) {
    throw new Error("--app-id is restricted to direct loopback checks");
  }

  parsedBaseUrl.pathname = parsedBaseUrl.pathname.replace(/\/+$/, "");

  const duration = parsePositiveInteger(durationSeconds, "duration-seconds");
  const heartbeats = parsePositiveInteger(minHeartbeats, "min-heartbeats", { allowZero: true });
  const heartbeatInterval = parsePositiveInteger(heartbeatIntervalSeconds, "heartbeat-interval-seconds");

  if (duration > 3_600) {
    throw new Error("duration-seconds must be no greater than 3600");
  }

  return {
    baseUrl: parsedBaseUrl,
    appId,
    allowHttp,
    durationSeconds: duration,
    minHeartbeats: heartbeats,
    heartbeatIntervalSeconds: heartbeatInterval,
  };
}

function requestUrl(baseUrl, pathname) {
  return new URL(pathname.replace(/^\//, ""), `${baseUrl.toString().replace(/\/$/, "")}/`);
}

function headersFor(options, initial) {
  const headers = { ...initial };
  if (options.appId !== undefined) {
    headers["X-Backend-App"] = options.appId;
  }
  return headers;
}

function requestJson(options, pathname, { method, token, body } = {}) {
  const url = requestUrl(options.baseUrl, pathname);
  const transport = url.protocol === "https:" ? https : http;
  const bodyText = body === undefined ? undefined : JSON.stringify(body);
  const headers = headersFor(options, {
    Accept: "application/json",
    "User-Agent": "scrum-poker-sse-smoke/1",
  });

  if (token !== undefined) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (bodyText !== undefined) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(bodyText);
  }

  return new Promise((resolve, reject) => {
    const request = transport.request(
      url,
      { method: method ?? "GET", headers, timeout: DEFAULT_REQUEST_TIMEOUT_MS },
      (response) => {
        let responseText = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseText += chunk;
        });
        response.on("end", () => {
          const statusCode = response.statusCode ?? 0;
          if (statusCode < 200 || statusCode >= 300) {
            reject(new Error(`HTTP request returned status ${statusCode}`));
            return;
          }

          if (statusCode === 204) {
            resolve(undefined);
            return;
          }

          try {
            resolve(JSON.parse(responseText));
          } catch {
            reject(new Error("HTTP request returned malformed JSON"));
          }
        });
      },
    );

    request.on("timeout", () => request.destroy(new Error("HTTP request timed out")));
    request.on("error", () => reject(new Error("HTTP request failed")));

    if (bodyText !== undefined) {
      request.write(bodyText);
    }
    request.end();
  });
}

function openSse(options, roomId, ticket) {
  const url = requestUrl(options.baseUrl, `/api/rooms/${encodeURIComponent(roomId)}/stream`);
  url.searchParams.set("ticket", ticket);
  const transport = url.protocol === "https:" ? https : http;
  let response;
  let buffer = "";
  let eventName = "message";
  let dataLines = [];
  let heartbeatCount = 0;
  let initialRevision;
  let latestRevision;
  let resolveInitial;
  let rejectInitial;
  let resolveRevision;
  let rejectRevision;
  let initialSettled = false;
  let revisionSettled = false;
  let request;

  const initial = new Promise((resolve, reject) => {
    resolveInitial = resolve;
    rejectInitial = reject;
  });
  const revision = new Promise((resolve, reject) => {
    resolveRevision = resolve;
    rejectRevision = reject;
  });

  function fail(error) {
    if (!initialSettled) {
      initialSettled = true;
      rejectInitial(error);
    }
    if (!revisionSettled) {
      revisionSettled = true;
      rejectRevision(error);
    }
  }

  function processEvent() {
    if (dataLines.length === 0) {
      eventName = "message";
      return;
    }

    const data = dataLines.join("\n");
    dataLines = [];
    const currentEvent = eventName;
    eventName = "message";

    if (currentEvent !== "snapshot") {
      return;
    }

    let snapshot;
    try {
      snapshot = JSON.parse(data);
    } catch {
      fail(new Error("SSE snapshot was malformed"));
      return;
    }

    if (!Number.isSafeInteger(snapshot?.q) || snapshot.q < 0) {
      fail(new Error("SSE snapshot revision was invalid"));
      return;
    }

    latestRevision = snapshot.q;
    if (initialRevision === undefined) {
      initialRevision = snapshot.q;
      if (!initialSettled) {
        initialSettled = true;
        resolveInitial(snapshot.q);
      }
    } else if (snapshot.q > initialRevision && !revisionSettled) {
      revisionSettled = true;
      resolveRevision(snapshot.q);
    }
  }

  function processLine(line) {
    if (line === "") {
      processEvent();
      return;
    }

    if (line.startsWith(":")) {
      heartbeatCount += 1;
      return;
    }

    if (line.startsWith("event:")) {
      eventName = line.slice("event:".length).trim() || "message";
      return;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).replace(/^ /, ""));
    }
  }

  const connected = new Promise((resolve, reject) => {
    request = transport.request(
      url,
      {
        method: "GET",
        headers: headersFor(options, {
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          "User-Agent": "scrum-poker-sse-smoke/1",
        }),
        timeout: Math.max(DEFAULT_REQUEST_TIMEOUT_MS, options.heartbeatIntervalSeconds * 3_000),
      },
      (candidateResponse) => {
        response = candidateResponse;
        const statusCode = response.statusCode ?? 0;
        const contentType = response.headers["content-type"] ?? "";
        if (statusCode !== 200 || !String(contentType).includes("text/event-stream")) {
          response.resume();
          reject(new Error(`SSE request returned status ${statusCode}`));
          return;
        }

        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          buffer += chunk;
          let lineEnd;
          while ((lineEnd = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, lineEnd).replace(/\r$/, "");
            buffer = buffer.slice(lineEnd + 1);
            processLine(line);
          }
        });
        response.on("error", () => fail(new Error("SSE stream failed")));
        response.on("aborted", () => fail(new Error("SSE stream aborted")));
        response.on("end", () => fail(new Error("SSE stream ended before the smoke check completed")));
        resolve();
      },
    );

    request.on("timeout", () => request.destroy(new Error("SSE request timed out")));
    request.on("error", () => reject(new Error("SSE request failed")));
    request.end();
  });

  return {
    connected,
    initial,
    revision,
    get heartbeatCount() {
      return heartbeatCount;
    },
    get latestRevision() {
      return latestRevision;
    },
    close() {
      response?.destroy();
      request?.destroy();
    },
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function runSmoke(options) {
  const displayName = `smoke-${Date.now().toString(36)}-${randomBytes(5).toString("hex")}`.slice(0, 30);
  const created = await requestJson(options, "/api/rooms", {
    method: "POST",
    body: { displayName },
  });

  const roomId = created?.roomId;
  const participantToken = created?.participantToken;
  if (typeof roomId !== "string" || typeof participantToken !== "string") {
    throw new Error("room creation response was invalid");
  }

  const ticketResponse = await requestJson(options, `/api/rooms/${encodeURIComponent(roomId)}/stream-ticket`, {
    method: "POST",
    token: participantToken,
  });
  const ticket = ticketResponse?.ticket;
  if (typeof ticket !== "string" || ticket.length === 0) {
    throw new Error("stream ticket response was invalid");
  }

  const stream = openSse(options, roomId, ticket);
  try {
    await stream.connected;
    const initialRevision = await stream.initial;

    await requestJson(options, `/api/rooms/${encodeURIComponent(roomId)}/votes`, {
      method: "POST",
      token: participantToken,
      body: { value: "5" },
    });
    const votedRevision = await stream.revision;
    if (votedRevision <= initialRevision) {
      throw new Error("vote did not produce a newer revision");
    }

    await delay(options.durationSeconds * 1_000);
    if (stream.heartbeatCount < options.minHeartbeats) {
      throw new Error(
        `observed ${stream.heartbeatCount} SSE heartbeats; expected at least ${options.minHeartbeats}`,
      );
    }

    console.log(
      `SSE smoke passed: duration=${options.durationSeconds}s heartbeats=${stream.heartbeatCount} ` +
        `revision=${votedRevision}`,
    );
  } finally {
    stream.close();
  }
}

try {
  const options = parseOptions(process.argv.slice(2));
  await runSmoke(options);
} catch (error) {
  usage();
  console.error(`SSE smoke failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
}
