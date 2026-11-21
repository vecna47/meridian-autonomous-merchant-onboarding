"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { once } = require("node:events");
const path = require("node:path");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");
const { hashPassword } = require("../server/passwords");
const { createTestApp, createMemoryRepository } = require("./helpers");

const root = path.join(__dirname, "..");
const html = readFileSync(path.join(root, "index.html"), "utf8");
const workflowSource = readFileSync(path.join(root, "workflow.js"), "utf8");
const appSource = readFileSync(path.join(root, "app.js"), "utf8");

async function waitFor(assertion, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(await assertion(), `Condition was not met within ${timeoutMs} ms`);
}

test("authenticated browser sync seeds PostgreSQL API and persists application changes", async (t) => {
  const repository = createMemoryRepository();
  repository.users.set("operator@example.test", {
    id: "00000000-0000-4000-8000-000000000001",
    email: "operator@example.test",
    passwordHash: await hashPassword("operator-password-123"),
    role: "admin",
    active: true
  });
  const server = createTestApp(repository).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const dom = new JSDOM(html, { runScripts: "outside-only", url: `${baseUrl}/` });
  t.after(() => dom.window.close());
  dom.window.HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  dom.window.HTMLDialogElement.prototype.close = function close() {
    this.open = false;
  };
  let cookie = "";
  dom.window.MERIDIAN_API_BASE_URL = "/api";
  dom.window.fetch = async (url, options = {}) => {
    const headers = { ...(options.headers || {}) };
    if (cookie) headers.Cookie = cookie;
    const response = await fetch(new URL(url, baseUrl), { ...options, headers });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return response;
  };
  dom.window.eval(workflowSource);
  dom.window.eval(appSource);

  const { document } = dom.window;
  await waitFor(() => document.querySelector("#login-dialog").open);
  document.querySelector("#login-form [name='email']").value = "operator@example.test";
  document.querySelector("#login-form [name='password']").value = "operator-password-123";
  document.querySelector("#login-form").dispatchEvent(
    new dom.window.Event("submit", { bubbles: true, cancelable: true })
  );
  await waitFor(() => !document.querySelector("#logout-button").hidden);
  assert.equal(document.querySelector("#login-dialog").open, false);
  assert.equal(document.querySelector("#operator-role").textContent, "Admin");

  const seededApplications = await fetch(`${baseUrl}/api/applications`, {
    headers: { Cookie: cookie }
  }).then((response) => response.json());
  assert.equal(seededApplications.length, 3);

  document.querySelector('[data-action="need-info"]').click();
  await waitFor(async () => {
    const saved = await fetch(`${baseUrl}/api/applications/APP-2026-0418`, {
      headers: { Cookie: cookie }
    }).then((response) => response.json());
    return saved.status === "needs_information";
  });
  assert.equal(document.querySelector("#detail-panel .status-pill").textContent.trim(), "Needs information");
});
