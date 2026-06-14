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

async function mockFrontendApis(page) {
  let jobCounter = 0;

  await page.addInitScript(() => {
    class MockEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = {};
        setTimeout(() => this.emit("progress", JSON.stringify("업로드 확인")), 20);
        setTimeout(() => this.emit("progress", JSON.stringify("AI 분석 중")), 45);
        setTimeout(() => this.emit("progress", JSON.stringify("문서 생성 중")), 70);
        setTimeout(() => {
          const id = String(url).match(/\/api\/jobs\/([^/]+)\/stream/)?.[1] || "qa-job";
          this.emit("done", JSON.stringify({ filename: `${id}.docx`, warnings: [] }));
        }, 95);
      }
      addEventListener(type, callback) {
        (this.listeners[type] ||= []).push(callback);
      }
      close() {
        this.closed = true;
      }
      emit(type, data) {
        if (this.closed) return;
        for (const callback of this.listeners[type] || []) callback({ data });
      }
    }
    window.EventSource = MockEventSource;
  });

  await page.route("**/api/me", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ user: "QA", studentId: "20260001", isAdmin: false, styleNote: "" }),
    });
  });
  await page.route("**/api/me/beta", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ features: [], blockedReportTypes: [] }),
    });
  });
  await page.route("**/api/me/balance", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ credits: 8, unlimited: false, isAdmin: false }),
    });
  });
  await page.route("**/api/me/files", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ storage: true, files: [], maxFilesPerUser: 3 }),
    });
  });
  await page.route("**/api/cloud/status", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ dropbox: { configured: false } }),
    });
  });
  await page.route("**/api/announcements", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        announcements: [
          { title: "정상 공지", category: "안내", link: "/notice" },
          { title: "스킴 차단 확인", category: "보안", link: "javascript:alert(1)" },
        ],
      }),
    });
  });
  await page.route("**/api/generate", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jobId: `qa-${++jobCounter}` }),
    });
  });
}

async function chooseReport(page, type) {
  const radio = page.locator(`input[name="reportType"][value="${type}"]`);
  await radio.check({ force: true });
  await expect(page.locator(`[data-report-form="${type}"]`)).toBeVisible();
}

async function acceptPolicy(page, type) {
  await page.locator(`[data-report-form="${type}"] .policy-check input[type="checkbox"]`).check({ force: true });
}

async function confirmGeneration(page) {
  await page.locator(".confirm-card button.primary").click();
  await expect(page.locator("#statusTitle")).toHaveText("완료", { timeout: 7000 });
  await expect(page.locator('#progressSteps [data-progress-step="ready"]')).toHaveClass(/is-active/);
  await expect(page.locator("#resultArea a")).toHaveAttribute("href", /\/api\/jobs\/qa-\d+\/download/);
}

test("mocked SSE report generation smoke: chem-pre, chem-result, phys-result", async ({ page }) => {
  await mockFrontendApis(page);
  await page.goto(BASE_URL);

  await expect(page.locator("body")).toHaveClass(/is-authenticated/);
  await expect(page.locator('#annTrack a[href^="javascript:"]')).toHaveCount(0);

  await chooseReport(page, "chem-pre");
  await page.fill("#date", "2026-06-14");
  await page.setInputFiles("#manual", {
    name: "manual.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\nqa\n%%EOF"),
  });
  await acceptPolicy(page, "chem-pre");
  await page.locator('#form button[type="submit"]').click();
  await confirmGeneration(page);

  await chooseReport(page, "chem-result");
  await page.fill("#crDate", "2026-06-14");
  await page.setInputFiles("#crPreReport", {
    name: "pre-report.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.4\nqa\n%%EOF"),
  });
  await acceptPolicy(page, "chem-result");
  await page.locator('#chemResultForm button[type="submit"]').click();
  await confirmGeneration(page);

  await chooseReport(page, "phys-result");
  await page.fill("#prDate", "2026-06-14");
  await page.setInputFiles("#prData", {
    name: "data.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("time,position\n0,0\n1,1\n"),
  });
  await acceptPolicy(page, "phys-result");
  await page.locator('#physResultForm button[type="submit"]').click();
  await confirmGeneration(page);
});
