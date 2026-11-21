"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const { test } = require("node:test");
const { hashPassword } = require("../server/passwords");
const { createMemoryRepository, createTestApp, sessionCookie } = require("./helpers");

function applicationRecord(id = "APP-TEST-1", status = "submitted") {
  const submittedAt = Date.now();
  const checks = ["ready_for_approval", "approved"].includes(status)
    ? { pan: "passed", gst: "passed", bank: "passed", risk: "passed" }
    : { pan: "pending", gst: "pending", bank: "pending", risk: "pending" };
  return {
    id,
    businessName: "Example Merchant",
    contactName: "Alex Example",
    email: "alex@example.test",
    pan: "•••••1234F",
    gst: "27••••••••••1Z5",
    bankAccount: "•••• 4821",
    submittedAt,
    status,
    checks,
    document: { name: "merchant-submitted-details.json", confidence: 98, source: "structured" },
    audit: [],
    stateHistory: [{ state: status, at: submittedAt }]
  };
}

async function getCsrfSession(baseUrl) {
  const response = await fetch(`${baseUrl}/api/session`);
  assert.equal(response.status, 200);
  return {
    cookie: sessionCookie(response),
    rawCookie: response.headers.get("set-cookie"),
    state: await response.json()
  };
}

async function login(baseUrl, email, password, cookie, csrfToken) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken
    },
    body: JSON.stringify({ email, password })
  });
  const updatedCookie = response.headers.get("set-cookie") ? sessionCookie(response) : cookie;
  return { response, cookie: updatedCookie };
}

test("API requires authenticated sessions, CSRF tokens, and reviewer roles", async (t) => {
  const repository = createMemoryRepository();
  const adminPassword = "correct-horse-battery";
  const operatorPassword = "operator-password-123";
  repository.users.set("admin@example.test", {
    id: "00000000-0000-4000-8000-000000000001",
    email: "admin@example.test",
    passwordHash: await hashPassword(adminPassword),
    role: "admin",
    active: true
  });
  repository.users.set("operator@example.test", {
    id: "00000000-0000-4000-8000-000000000002",
    email: "operator@example.test",
    passwordHash: await hashPassword(operatorPassword),
    role: "operator",
    active: true
  });
  const server = createTestApp(repository).listen(0, "127.0.0.1");
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

  const unauthorized = await fetch(`${baseUrl}/api/applications`);
  assert.equal(unauthorized.status, 401);

  const adminSession = await getCsrfSession(baseUrl);
  assert.equal(adminSession.state.authenticated, false);
  assert.ok(adminSession.state.csrfToken);
  assert.match(adminSession.rawCookie, /HttpOnly/i);

  const invalidLogin = await login(
    baseUrl,
    "admin@example.test",
    "incorrect-password",
    adminSession.cookie,
    adminSession.state.csrfToken
  );
  assert.equal(invalidLogin.response.status, 401);

  const adminLogin = await login(
    baseUrl,
    "admin@example.test",
    adminPassword,
    adminSession.cookie,
    adminSession.state.csrfToken
  );
  assert.equal(adminLogin.response.status, 200);
  assert.notEqual(adminLogin.cookie, adminSession.cookie);
  const adminCredentials = await adminLogin.response.json();
  assert.equal(adminCredentials.user.role, "admin");

  const application = applicationRecord();
  const missingCsrf = await fetch(`${baseUrl}/api/applications/${application.id}`, {
    method: "PUT",
    headers: { Cookie: adminLogin.cookie, "Content-Type": "application/json" },
    body: JSON.stringify(application)
  });
  assert.equal(missingCsrf.status, 403);

  const create = await fetch(`${baseUrl}/api/applications/${application.id}`, {
    method: "PUT",
    headers: {
      Cookie: adminLogin.cookie,
      "Content-Type": "application/json",
      "X-CSRF-Token": adminCredentials.csrfToken
    },
    body: JSON.stringify(application)
  });
  assert.equal(create.status, 200);

  const list = await fetch(`${baseUrl}/api/applications`, { headers: { Cookie: adminLogin.cookie } });
  assert.deepEqual(await list.json(), [application]);

  const unmaskedPan = { ...application, pan: "ABCDE1234F" };
  const rejectedSensitiveData = await fetch(`${baseUrl}/api/applications/${application.id}`, {
    method: "PUT",
    headers: {
      Cookie: adminLogin.cookie,
      "Content-Type": "application/json",
      "X-CSRF-Token": adminCredentials.csrfToken
    },
    body: JSON.stringify(unmaskedPan)
  });
  assert.equal(rejectedSensitiveData.status, 400);

  const skippedChecks = { ...application, status: "ready_for_approval" };
  const rejectedUnverifiedApproval = await fetch(`${baseUrl}/api/applications/${application.id}`, {
    method: "PUT",
    headers: {
      Cookie: adminLogin.cookie,
      "Content-Type": "application/json",
      "X-CSRF-Token": adminCredentials.csrfToken
    },
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
    headers: {
      Cookie: adminLogin.cookie,
      "Content-Type": "application/json",
      "X-CSRF-Token": adminCredentials.csrfToken
    },
    body: JSON.stringify(skippedState)
  });
  assert.equal(rejectedTransition.status, 409);

  const reviewerOnlyApplication = applicationRecord("APP-REVIEW-ONLY", "ready_for_approval");
  repository.applications.set(reviewerOnlyApplication.id, reviewerOnlyApplication);
  const operatorSession = await getCsrfSession(baseUrl);
  const operatorLogin = await login(
    baseUrl,
    "operator@example.test",
    operatorPassword,
    operatorSession.cookie,
    operatorSession.state.csrfToken
  );
  assert.equal(operatorLogin.response.status, 200);
  const operatorCredentials = await operatorLogin.response.json();
  const forbiddenCreate = await fetch(`${baseUrl}/api/applications/APP-OPERATOR-CREATE`, {
    method: "PUT",
    headers: {
      Cookie: operatorLogin.cookie,
      "Content-Type": "application/json",
      "X-CSRF-Token": operatorCredentials.csrfToken
    },
    body: JSON.stringify(applicationRecord("APP-OPERATOR-CREATE", "approved"))
  });
  assert.equal(forbiddenCreate.status, 403);

  const forbiddenApproval = await fetch(`${baseUrl}/api/applications/${reviewerOnlyApplication.id}`, {
    method: "PUT",
    headers: {
      Cookie: operatorLogin.cookie,
      "Content-Type": "application/json",
      "X-CSRF-Token": operatorCredentials.csrfToken
    },
    body: JSON.stringify({ ...reviewerOnlyApplication, status: "approved" })
  });
  assert.equal(forbiddenApproval.status, 403);

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: { Cookie: adminLogin.cookie, "X-CSRF-Token": adminCredentials.csrfToken }
  });
  assert.equal(logout.status, 204);
  const afterLogout = await fetch(`${baseUrl}/api/applications`, { headers: { Cookie: adminLogin.cookie } });
  assert.equal(afterLogout.status, 401);
});
