const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function loadPlaywrightTest() {
  try {
    return require("@playwright/test");
  } catch (error) {
    const marker = `${path.sep}node_modules${path.sep}`;
    const cacheKey = Object.keys(require.cache).find(
      (key) =>
        key.includes(`${marker}@playwright${path.sep}test${path.sep}`) ||
        key.includes(`${marker}playwright${path.sep}`),
    );
    if (!cacheKey) throw error;
    const root = cacheKey.slice(0, cacheKey.indexOf(marker) + marker.length);
    return require(path.join(root, "@playwright", "test"));
  }
}

const { test, expect } = loadPlaywrightTest();
const BASE_URL = process.env.QA_BASE_URL || "http://127.0.0.1:3000";
const SCREEN_DIR = path.join(process.cwd(), "test-results", "frontend-screens");
let serverProcess = null;

async function serverIsUp() {
  try {
    const res = await fetch(BASE_URL);
    return res.ok || res.status < 500;
  } catch (_) {
    return false;
  }
}

async function waitForServer() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await serverIsUp()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Server did not start at ${BASE_URL}`);
}

async function mockLoggedInApis(page) {
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname === "/api/announcements") {
      return route.fulfill({ json: { announcements: [] } });
    }
    if (pathname === "/api/me") {
      return route.fulfill({
        json: {
          user: "QA",
          studentId: "2402",
          isAdmin: false,
          styleNote: "",
          blockedReportTypes: [],
        },
      });
    }
    if (pathname === "/api/me/beta") {
      return route.fulfill({ json: { admin: false, features: [] } });
    }
    if (pathname === "/api/me/balance") {
      return route.fulfill({ json: { credits: 8, unlimited: false } });
    }
    if (pathname === "/api/me/files") {
      return route.fulfill({
        json: {
          storage: true,
          cloud: null,
          maxFilesPerUser: 3,
          files: [
            {
              id: "qa-file-1",
              filename: "화학_사전보고서_QA.docx",
              size_bytes: 128000,
              created_at: "2026-06-14T01:00:00.000Z",
              expires_at: "2026-06-15T01:00:00.000Z",
            },
          ],
        },
      });
    }
    if (pathname === "/api/cloud/dropbox/status") {
      return route.fulfill({ json: { enabled: false } });
    }
    if (pathname === "/api/me/usage") {
      return route.fulfill({
        json: {
          credits: 8,
          genCount: 1,
          genLimit: 5,
          recent: [
            { date: "2026-06-14T01:00:00.000Z", label: "화학 사전보고서", model: "gpt-5.4", credits: 1 },
          ],
        },
      });
    }
    return route.fulfill({ json: {} });
  });
}

test.beforeAll(async () => {
  if (await serverIsUp()) return;
  serverProcess = spawn("node", ["server.js"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: "3000" },
    stdio: "pipe",
  });
  await waitForServer();
});

test.afterAll(async () => {
  if (serverProcess) serverProcess.kill();
});

test("logged-in workspace and report form layout render cleanly", async ({ page }) => {
  fs.mkdirSync(SCREEN_DIR, { recursive: true });
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await mockLoggedInApis(page);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await expect(page.locator("body")).toHaveAttribute("data-auth", "in");
  await expect(page.locator("#reportTypes")).toBeVisible();
  await expect(page.locator("#workspaceSummary")).toBeVisible();
  await expect(page.locator("#loginDd")).toBeHidden();
  await expect(page.locator("#acctDd")).toBeVisible();

  const visualOrder = await page.evaluate(() => {
    const reportTypes = document.querySelector("#reportTypes").getBoundingClientRect();
    const hero = document.querySelector("#homeHero").getBoundingClientRect();
    return { reportTypesTop: reportTypes.top, heroTop: hero.top };
  });
  expect(visualOrder.reportTypesTop).toBeLessThan(visualOrder.heroTop);

  await page.evaluate(() => {
    const input = document.querySelector('input[name="reportType"][value="chem-pre"]');
    input.checked = true;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await expect(page.locator("#form.report-flow.active")).toBeVisible();
  await expect(page.locator("#form .optional-settings")).toBeVisible();
  await page.screenshot({ path: path.join(SCREEN_DIR, "desktop-1280.png"), fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await expect(page.locator("#workspaceSummary")).toBeVisible();
  await page.screenshot({ path: path.join(SCREEN_DIR, "mobile-390.png"), fullPage: true });

  expect(errors).toEqual([]);
});

test("secondary UX pages render without console errors", async ({ page }) => {
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`${page.url()}: ${msg.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`));

  await page.route("**/api/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/api/community/posts") {
      return route.fulfill({ json: { storage: true, posts: [] } });
    }
    if (pathname === "/api/lab/entries") {
      return route.fulfill({ json: { entries: [] } });
    }
    if (pathname === "/api/me/beta") {
      return route.fulfill({ json: { admin: false, features: [] } });
    }
    if (pathname === "/api/artifacts/gallery") {
      return route.fulfill({ json: { items: [] } });
    }
    if (pathname === "/api/artifacts") {
      return route.fulfill({ json: { persistent: true, artifacts: [] } });
    }
    return route.fulfill({ json: {} });
  });

  for (const pathName of ["/tools/convert.html", "/guide.html", "/examples.html", "/community.html", "/create.html"]) {
    await page.goto(`${BASE_URL}${pathName}`, { waitUntil: "domcontentloaded" });
    await expect(page.locator("body")).toBeVisible();
  }

  expect(errors).toEqual([]);
});
