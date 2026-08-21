const { join } = require("node:path");
const { spawn } = require("node:child_process");
const { test, expect } = require("@playwright/test");

const ROOT_DIR = process.cwd();
const HOST = "127.0.0.1";
const STARTUP_TIMEOUT_MS = 60_000;
const VITE_COMMAND = join(ROOT_DIR, "node_modules", ".bin", process.platform === "win32" ? "vite.cmd" : "vite");

function readApiUrl() {
  const value = process.env.VITE_API_BASE_URL?.trim();
  if (!value) {
    throw new Error("VITE_API_BASE_URL is required for E2E tests against the externally managed backend.");
  }

  const url = new URL(value);
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("VITE_API_BASE_URL must be an HTTP(S) API origin without credentials, query, or fragment.");
  }

  return url.toString().replace(/\/$/, "");
}

function readWebPort() {
  const port = Number(process.env.E2E_WEB_PORT ?? "4173");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("E2E_WEB_PORT must be a valid TCP port.");
  }
  return port;
}

async function runCommand(command, args, env) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        ...env,
      },
      shell: process.platform === "win32",
      stdio: "pipe",
    });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `Command failed: ${command} ${args.join(" ")}`));
    });
  });
}

async function waitForHttp(url, predicate = (response) => response.ok) {
  const start = Date.now();

  while (Date.now() - start < STARTUP_TIMEOUT_MS) {
    try {
      const response = await fetch(url);

      if (predicate(response)) {
        return;
      }
    } catch {
      // Retry until the timeout is reached.
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function stopProcess(processToStop) {
  if (!processToStop || processToStop.exitCode !== null) {
    return;
  }

  await new Promise((resolve, reject) => {
    processToStop.once("error", reject);
    processToStop.once("exit", () => resolve());
    processToStop.kill("SIGTERM");
  });
}

async function createEnvironment() {
  const apiUrl = readApiUrl();
  const webPort = readWebPort();
  const webUrl = `http://${HOST}:${webPort}`;

  await runCommand(
    VITE_COMMAND,
    ["build", "--config", "apps/web/vite.config.ts"],
    {
      VITE_API_BASE_URL: apiUrl,
      VITE_BASE_PATH: "/",
    },
  );

  const previewProcess = spawn(
    VITE_COMMAND,
    ["preview", "--config", "apps/web/vite.config.ts", "--host", HOST, "--port", String(webPort), "--strictPort"],
    {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
      },
      shell: process.platform === "win32",
      stdio: "pipe",
    },
  );

  await waitForHttp(webUrl);

  return {
    previewProcess,
    webUrl,
    dispose: async () => {
      await stopProcess(previewProcess);
    },
  };
}

function attachNetworkCapture(page) {
  const requests = [];
  const websockets = [];

  page.on("request", (request) => {
    requests.push({
      method: request.method(),
      resourceType: request.resourceType(),
      url: request.url(),
    });
  });
  page.on("websocket", (websocket) => {
    websockets.push(websocket.url());
  });

  return { requests, websockets };
}

function deckCard(page, value) {
  return page.getByRole("button", { name: String(value), exact: true });
}

test.describe.configure({ mode: "serial" });

let environment;

test.beforeAll(async () => {
  environment = await createEnvironment();
});

test.afterAll(async () => {
  if (environment !== undefined) {
    await environment.dispose();
  }
});

test("creator and participants complete a private round over HTTP and EventSource only", async ({ browser }) => {
  test.slow();

  const creator = await browser.newContext();
  const participant = await browser.newContext();
  const observer = await browser.newContext();
  const creatorPage = await creator.newPage();
  const participantPage = await participant.newPage();
  const observerPage = await observer.newPage();

  const creatorNetwork = attachNetworkCapture(creatorPage);
  const participantNetwork = attachNetworkCapture(participantPage);

  await creatorPage.goto(environment.webUrl);
  await creatorPage.getByLabel(/display name/i).fill("Alex");
  await creatorPage.getByRole("button", { name: /create room/i }).click();

  await expect(creatorPage).toHaveURL(/#\/room\//);

  const roomUrl = creatorPage.url();
  const roomId = roomUrl.split("/room/")[1] ?? "";

  expect(roomId).not.toEqual("");
  await expect(creatorPage.getByRole("button", { name: /reveal votes/i })).toBeVisible();

  await participantPage.goto(roomUrl);
  await expect(participantPage.getByRole("heading", { name: /estimate together/i })).toBeVisible();
  await expect(participantPage.getByLabel(/room code/i)).toHaveValue(roomId);
  await participantPage.getByLabel(/display name/i).fill("Sam");
  await participantPage.getByRole("button", { name: /join room/i }).click();
  await expect(participantPage).toHaveURL(new RegExp(`#\\/room\\/${roomId}$`));
  await expect(participantPage.getByRole("button", { name: /reveal votes/i })).toHaveCount(0);
  await expect(participantPage.getByRole("button", { name: /reset round/i })).toHaveCount(0);

  await creatorPage.reload();
  await expect(creatorPage.getByRole("button", { name: /reveal votes/i })).toBeVisible();

  await observerPage.goto(roomUrl);
  await expect(observerPage.getByRole("heading", { name: /estimate together/i })).toBeVisible();
  await observerPage.getByLabel(/display name/i).fill("Tia");
  await observerPage.getByRole("button", { name: /join room/i }).click();
  await expect(observerPage.getByRole("button", { name: /reveal votes/i })).toHaveCount(0);
  await expect(observerPage.getByRole("button", { name: /reset round/i })).toHaveCount(0);

  const creatorFive = deckCard(creatorPage, 5);
  const participantEight = deckCard(participantPage, 8);
  await expect(creatorFive).toHaveCount(1);
  await expect(participantEight).toHaveCount(1);
  await creatorFive.click();
  await participantEight.click();

  const creatorParticipants = creatorPage.getByRole("list", { name: /participants/i });
  const participantRows = participantPage.getByRole("list", { name: /participants/i }).getByRole("listitem");

  await expect(creatorParticipants).toContainText("Voted");
  await expect(participantRows.nth(0)).not.toContainText(/\b5\b/);
  await expect(participantRows.nth(1)).not.toContainText(/\b8\b/);

  await creatorPage.getByRole("button", { name: /reveal votes/i }).click();

  const distribution = creatorPage.getByRole("list", { name: /revealed vote distribution/i });
  await expect(distribution).toContainText("5");
  await expect(distribution).toContainText("1 vote");
  await expect(distribution).toContainText("8");

  const revealedParticipants = participantPage.getByRole("list", { name: /participants/i });
  await expect(revealedParticipants).toContainText("5");
  await expect(revealedParticipants).toContainText("8");

  await creatorPage.getByRole("button", { name: /reset round/i }).click();

  await expect(creatorPage.getByRole("list", { name: /revealed vote distribution/i })).toHaveCount(0);
  await expect(creatorPage.getByRole("list", { name: /participants/i })).toContainText("Waiting");

  expect(participantNetwork.requests.filter((request) => /\/(reveal|reset)$/.test(request.url))).toHaveLength(0);

  const combinedRequests = [...creatorNetwork.requests, ...participantNetwork.requests];
  const combinedWebsockets = [...creatorNetwork.websockets, ...participantNetwork.websockets];

  expect(combinedRequests.some((request) => request.resourceType === "document" || request.resourceType === "fetch")).toBe(true);
  expect(
    combinedRequests.some(
      (request) => request.resourceType === "eventsource" || /\/stream\?ticket=/.test(request.url),
    ),
  ).toBe(true);
  expect(combinedRequests.some((request) => /websocket/i.test(request.url))).toBe(false);
  expect(combinedWebsockets).toEqual([]);

  await Promise.all([creator.close(), participant.close(), observer.close()]);
});
