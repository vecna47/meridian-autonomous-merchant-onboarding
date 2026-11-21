"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const { test } = require("node:test");
const workflow = require("../workflow");
const { createApp, InvalidStateTransitionError } = require("../server");

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

function applicationRecord(id = "APP-TEST-1") {
  const submittedAt = Date.now();
  return {
    id,
    businessName: "Example Merchant",
    contactName: "Alex Example",
    email: "alex@example.test",
    pan: "•••••1234F",
    gst: "27••••••••••1Z5",
    bankAccount: "•••• 4821",
    submittedAt,
    status: "submitted",
    checks: { pan: "pending", gst: "pending", bank: "pending", risk: "pending" },
    document: { name: "merchant-submitted-details.json", confidence: 98, source: "structured" },
    audit: [],
    stateHistory: [{ state: "submitted", at: submittedAt }]
  };
}

test("API persists validated applications and rejects unsafe state updates", async (t) => {
  const repository = createMemoryRepository();
  const server = createApp(repository).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const homepage = await fetch(`${baseUrl}/`);
  assert.equal(homepage.status, 200);
  assert.match(await homepage.text(), /Merchant onboarding/);
  const runtimeConfig = await fetch(`${baseUrl}/runtime-config.js`);
  assert.equal(runtimeConfig.status, 200);
  assert.match(await runtimeConfig.text(), /MERIDIAN_API_BASE_URL = "\/api"/);

  const application = applicationRecord();
  const create = await fetch(`${baseUrl}/api/applications/${application.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(application)
  });
  assert.equal(create.status, 200);

  const list = await fetch(`${baseUrl}/api/applications`);
  assert.deepEqual(await list.json(), [application]);

  const unmaskedPan = { ...application, pan: "ABCDE1234F" };
  const rejectedSensitiveData = await fetch(`${baseUrl}/api/applications/${application.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(unmaskedPan)
  });
  assert.equal(rejectedSensitiveData.status, 400);

  const skippedChecks = {
    ...application,
    status: "ready_for_approval"
  };
  const rejectedUnverifiedApproval = await fetch(`${baseUrl}/api/applications/${application.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(skippedChecks)
  });
  assert.equal(rejectedUnverifiedApproval.status, 400);

  const skippedState = {
    ...application,
    status: "approved",
    checks: { pan: "passed", gst: "passed", bank: "passed", risk: "passed" }
  };
  const rejectedTransition = await fetch(`${baseUrl}/api/applications/${application.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(skippedState)
  });
  assert.equal(rejectedTransition.status, 409);

  const missing = await fetch(`${baseUrl}/api/applications/APP-NOT-FOUND`);
  assert.equal(missing.status, 404);
});
