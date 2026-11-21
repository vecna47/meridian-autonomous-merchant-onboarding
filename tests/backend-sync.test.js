"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { once } = require("node:events");
const path = require("node:path");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");
const workflow = require("../workflow");
const { createApp, InvalidStateTransitionError } = require("../server");

const root = path.join(__dirname, "..");
const html = readFileSync(path.join(root, "index.html"), "utf8");
const workflowSource = readFileSync(path.join(root, "workflow.js"), "utf8");
const appSource = readFileSync(path.join(root, "app.js"), "utf8");

function createMemoryRepository() {
  const records = new Map();
  return {
    async health() {},
    async list() {
      return [...records.values()];
    },
    async get(id) {
      return records.get(id) || null;
    },
    async save(application) {
      const current = records.get(application.id);
      if (current && !workflow.canTransition(current.status, application.status)) {
        throw new InvalidStateTransitionError(current.status, application.status);
      }
      records.set(application.id, JSON.parse(JSON.stringify(application)));
      return application;
    }
  };
}

async function waitFor(assertion, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(await assertion(), `Condition was not met within ${timeoutMs} ms`);
}

test("browser sync seeds PostgreSQL API and persists operator changes", async (t) => {
  const server = createApp(createMemoryRepository()).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const dom = new JSDOM(html, { runScripts: "outside-only", url: `${baseUrl}/` });
  t.after(() => dom.window.close());
  dom.window.MERIDIAN_API_BASE_URL = "/api";
  dom.window.fetch = (url, options) => fetch(new URL(url, baseUrl), options);
  dom.window.eval(workflowSource);
  dom.window.eval(appSource);

  await waitFor(() => dom.window.document.querySelector(".app-shell").getAttribute("aria-busy") === "false");
  const seededApplications = await fetch(`${baseUrl}/api/applications`).then((response) => response.json());
  assert.equal(seededApplications.length, 3);

  dom.window.document.querySelector('[data-action="need-info"]').click();
  await waitFor(async () => {
    const saved = await fetch(`${baseUrl}/api/applications/APP-2026-0418`).then((response) => response.json());
    return saved.status === "needs_information";
  });
  assert.equal(dom.window.document.querySelector("#detail-panel .status-pill").textContent.trim(), "Needs information");
});
