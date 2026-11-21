"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { JSDOM } = require("jsdom");

const root = path.join(__dirname, "..");
const html = readFileSync(path.join(root, "index.html"), "utf8");
const appSource = readFileSync(path.join(root, "app.js"), "utf8");

function createApplication(overrides = {}) {
  const dom = new JSDOM(html, {
    runScripts: "outside-only",
    url: "http://localhost/"
  });
  const { window } = dom;
  window.HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  window.HTMLDialogElement.prototype.close = function close() {
    this.open = false;
  };
  window.prompt = () => "123456789012";
  window.eval(appSource);

  const document = window.document;
  document.querySelector("#new-application").click();
  const values = {
    businessName: "Northstar Coffee Co.",
    contactName: "Avery Chen",
    email: "avery@northstar.example",
    pan: "ABCDE1234F",
    gst: "27ABCDE1234F1Z5",
    bankAccount: "123456789012",
    documentConfidence: "98",
    riskScore: "24",
    callbackScenario: "standard",
    provisioningScenario: "standard",
    ...overrides
  };

  for (const [name, value] of Object.entries(values)) {
    document.querySelector(`#application-form [name="${name}"]`).value = value;
  }
  document.querySelector("#application-form").dispatchEvent(
    new window.Event("submit", { bubbles: true, cancelable: true })
  );
  return { dom, document, window };
}

function statusOf(document) {
  return document.querySelector("#detail-panel .status-pill")?.textContent.trim();
}

function checkResults(document) {
  return Object.fromEntries(
    [...document.querySelectorAll("#detail-panel .check-item")].map((item) => [
      item.querySelector(".check-name").textContent.trim(),
      item.querySelector(".check-result").textContent.trim()
    ])
  );
}

function auditContains(document, text) {
  return [...document.querySelectorAll("#detail-panel .audit-copy")]
    .some((event) => event.textContent.includes(text));
}

async function waitFor(assertion, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(assertion(), `Condition was not met within ${timeoutMs} ms`);
}

test("seeded journey retries a failed check, gates approval, and recovers provisioning", async (t) => {
  const dom = new JSDOM(html, { runScripts: "outside-only", url: "http://localhost/" });
  t.after(() => dom.window.close());
  dom.window.prompt = () => "123456789012";
  dom.window.eval(appSource);
  const { document } = dom.window;

  document.querySelector('[data-action="run-checks"]').click();
  await waitFor(() => statusOf(document) === "Needs review");
  assert.equal(checkResults(document)["PAN verification"], "Passed");
  assert.equal(checkResults(document)["GST verification"], "Failed");
  assert.equal(document.querySelector('[data-action="approve"]'), null);
  assert.ok(auditContains(document, "Duplicate PAN verification callback ignored"));

  document.querySelector('[data-action="retry-failed"]').click();
  await waitFor(() => statusOf(document) === "Ready for approval");
  assert.equal(checkResults(document)["GST verification"], "Passed");

  document.querySelector('[data-action="approve"]').click();
  assert.equal(statusOf(document), "Provisioning failed");
  assert.equal(document.querySelector('[data-action="provision"]').textContent.trim(), "Retry merchant ID creation");

  document.querySelector('[data-action="provision"]').click();
  assert.equal(statusOf(document), "Approved");
  assert.match(document.querySelector("#detail-panel").textContent, /MID-\d{6}/);

  document.querySelector('[data-action="change-bank"]').click();
  assert.equal(statusOf(document), "Submitted");
  assert.doesNotMatch(document.querySelector("#detail-panel .detail-status").textContent, /MID-\d{6}/);
  assert.equal(checkResults(document)["Bank account"], "Pending");
  assert.equal(checkResults(document)["Risk screening"], "Pending");
});

test("new applications route duplicates and low-confidence submissions to review", (t) => {
  const duplicate = createApplication({ email: "maya@asterandoak.in" });
  t.after(() => duplicate.dom.window.close());
  assert.equal(statusOf(duplicate.document), "Needs review");
  assert.match(duplicate.document.querySelector("#detail-panel").textContent, /Possible existing applications/);

  const lowConfidence = createApplication({
    email: "new@northstar.example",
    documentConfidence: "72"
  });
  t.after(() => lowConfidence.dom.window.close());
  assert.equal(statusOf(lowConfidence.document), "Needs review");
  assert.match(lowConfidence.document.querySelector("#detail-panel").textContent, /below the 85% review threshold/);
});

test("high-risk applications require review even when every check passes", async (t) => {
  const app = createApplication({
    email: "risk@northstar.example",
    riskScore: "82"
  });
  t.after(() => app.dom.window.close());

  app.document.querySelector('[data-action="run-checks"]').click();
  await waitFor(() => statusOf(app.document) === "Needs review");
  assert.ok(Object.values(checkResults(app.document)).every((result) => result === "Passed"));
  assert.equal(app.document.querySelector('[data-action="approve"]'), null);

  app.document.querySelector('[data-action="review-clear"]').click();
  assert.equal(statusOf(app.document), "Ready for approval");
  app.document.querySelector('[data-action="approve"]').click();
  assert.equal(statusOf(app.document), "Approved");
  assert.match(app.document.querySelector("#detail-panel").textContent, /MID-\d{6}/);
});

test("late bank callbacks are ignored after a provider timeout", async (t) => {
  const app = createApplication({
    email: "late@northstar.example",
    callbackScenario: "late_bank_callback"
  });
  t.after(() => app.dom.window.close());

  app.document.querySelector('[data-action="run-checks"]').click();
  await waitFor(() => statusOf(app.document) === "Needs review");
  assert.equal(checkResults(app.document)["Bank account"], "Timed out");

  await waitFor(() => auditContains(app.document, "Late Bank account callback ignored after timeout"), 6000);
  assert.equal(statusOf(app.document), "Needs review");
  assert.equal(checkResults(app.document)["Bank account"], "Timed out");
});
