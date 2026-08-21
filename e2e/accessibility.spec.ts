const { join } = require("node:path");
const { spawn } = require("node:child_process");
const AxeBuilder = require("@axe-core/playwright").default;
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

async function expectNoSeriousViolations(page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const reportable = violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");

  expect(reportable, JSON.stringify(reportable, null, 2)).toEqual([]);
}

async function expectNoHorizontalOverflow(page) {
  await expect
    .poll(async () =>
      page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    )
    .toBe(true);
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

test("landing, voting, and revealed views stay accessible on a narrow viewport", async ({ browser }) => {
  test.slow();

  const creator = await browser.newContext({
    viewport: {
      width: 390,
      height: 844,
    },
  });
  const participant = await browser.newContext({
    viewport: {
      width: 390,
      height: 844,
    },
  });
  const creatorPage = await creator.newPage();
  const participantPage = await participant.newPage();

  await creatorPage.goto(environment.webUrl);
  await expect(creatorPage.getByRole("heading", { name: /estimate together/i })).toBeVisible();
  await expectNoHorizontalOverflow(creatorPage);
  await expectNoSeriousViolations(creatorPage);

  await creatorPage.getByLabel(/display name/i).fill("Alex");
  await creatorPage.getByRole("button", { name: /create room/i }).focus();
  await creatorPage.keyboard.press("Enter");
  await expect(creatorPage).toHaveURL(/#\/room\//);
  await expectNoHorizontalOverflow(creatorPage);
  await expectNoSeriousViolations(creatorPage);

  const roomUrl = creatorPage.url();
  await participantPage.goto(roomUrl);
  await participantPage.getByLabel(/display name/i).fill("Sam");
  await participantPage.getByRole("button", { name: /join room/i }).click();

  const creatorFive = deckCard(creatorPage, 5);
  const participantEight = deckCard(participantPage, 8);
  await expect(creatorFive).toHaveCount(1);
  await expect(participantEight).toHaveCount(1);
  await creatorFive.focus();
  await creatorPage.keyboard.press("Enter");
  await expect(creatorPage.getByText(/selected card: 5/i)).toBeVisible();

  await participantEight.focus();
  await participantPage.keyboard.press("Enter");
  await expect(participantPage.getByText(/selected card: 8/i)).toBeVisible();

  await creatorPage.getByRole("button", { name: /reveal votes/i }).focus();
  await creatorPage.keyboard.press("Enter");
  await expect(creatorPage.getByRole("list", { name: /revealed vote distribution/i })).toBeVisible();
  await expectNoHorizontalOverflow(creatorPage);
  await expectNoSeriousViolations(creatorPage);

  await Promise.all([creator.close(), participant.close()]);
});
