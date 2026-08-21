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
    webUrl,
    dispose: async () => {
      await stopProcess(previewProcess);
    },
  };
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

test("shows recovery messaging when the browser goes offline and reconnects on demand", async ({ browser }) => {
  test.slow();

  const context = await browser.newContext();
  const page = await context.newPage();

  await page.addInitScript(() => {
    const NativeEventSource = window.EventSource;

    class TrackedEventSource extends NativeEventSource {
      constructor(url, eventSourceInitDict) {
        super(url, eventSourceInitDict);
        window.__scrumPokerEventSource = this;
      }
    }

    window.EventSource = TrackedEventSource;
  });

  await page.goto(environment.webUrl);
  await page.getByLabel(/display name/i).fill("Alex");
  await page.getByRole("button", { name: /create room/i }).click();
  await expect(page.getByText(/live connection active/i)).toBeVisible();

  await context.setOffline(true);
  await page.evaluate(() => {
    window.__scrumPokerEventSource?.dispatchEvent(new Event("error"));
  });
  await expect(page.getByText(/offline\. live updates are paused until you reconnect\./i)).toBeVisible();
  await expect(page.getByRole("button", { name: /reconnect/i })).toBeVisible();

  await context.setOffline(false);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);
  const reconnectTicket = page.waitForResponse(
    (response) => response.request().method() === "POST" && /\/stream-ticket$/.test(response.url()),
  );
  await page.getByRole("button", { name: /reconnect/i }).click();
  await expect((await reconnectTicket).status()).toBe(201);
  await expect(page.getByText(/live connection active/i)).toBeVisible();

  await context.close();
});
