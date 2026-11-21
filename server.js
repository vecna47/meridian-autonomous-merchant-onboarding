"use strict";

const express = require("express");
const { Pool } = require("pg");
const path = require("node:path");
const workflow = require("./workflow");
const { createPostgresRepository, InvalidStateTransitionError } = require("./server/postgres-repository");

const ROOT = __dirname;
const APPLICATION_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const CHECK_STATES = new Set(["pending", "running", "retrying", "passed", "failed"]);
const REQUIRED_CHECKS = ["pan", "gst", "bank", "risk"];
const MASKED_PAN_PATTERN = /^•{5}[A-Z0-9]{5}$/;
const MASKED_GST_PATTERN = /^\d{2}•{10}[A-Z0-9]{3}$/;
const MASKED_BANK_PATTERN = /^•{4} \d{4}$/;

function validateApplication(id, application) {
  if (!application || typeof application !== "object" || Array.isArray(application)) {
    return "Application body must be a JSON object.";
  }
  if (!APPLICATION_ID_PATTERN.test(id) || application.id !== id) {
    return "Application ID must match the request path.";
  }
  if (!Object.hasOwn(workflow.allowedTransitions, application.status)) {
    return "Application status is invalid.";
  }
  for (const field of ["businessName", "contactName", "email"]) {
    if (typeof application[field] !== "string" || !application[field].trim()) {
      return `${field} is required.`;
    }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(application.email)) {
    return "A valid email address is required.";
  }
  if (!MASKED_PAN_PATTERN.test(application.pan || "")) {
    return "PAN must be masked before it is stored.";
  }
  if (!MASKED_GST_PATTERN.test(application.gst || "")) {
    return "GSTIN must be masked before it is stored.";
  }
  if (!MASKED_BANK_PATTERN.test(application.bankAccount || "")) {
    return "Bank account number must be masked before it is stored.";
  }
  if (!Number.isFinite(application.submittedAt) || !Number.isFinite(new Date(application.submittedAt).getTime())) {
    return "submittedAt must be a valid timestamp.";
  }
  if (!application.checks || typeof application.checks !== "object" || Array.isArray(application.checks)) {
    return "Provider check statuses are required.";
  }
  for (const key of REQUIRED_CHECKS) {
    if (!CHECK_STATES.has(application.checks[key])) {
      return `A valid ${key} check status is required.`;
    }
  }
  if (
    ["ready_for_approval", "approved", "provisioning_failed"].includes(application.status)
    && !REQUIRED_CHECKS.every((key) => application.checks[key] === "passed")
  ) {
    return "Approval and provisioning states require every provider check to pass.";
  }
  if (!application.document || typeof application.document !== "object" || Array.isArray(application.document)) {
    return "Document extraction metadata is required.";
  }
  if (!Array.isArray(application.audit) || !Array.isArray(application.stateHistory)) {
    return "Audit and state history must be arrays.";
  }
  return null;
}

function createApp(repository) {
  if (!repository) throw new Error("An application repository is required.");
  const app = express();
  app.disable("x-powered-by");
  app.use((request, response, next) => {
    response.set("X-Content-Type-Options", "nosniff");
    response.set("Referrer-Policy", "strict-origin-when-cross-origin");
    response.set("X-Frame-Options", "DENY");
    next();
  });
  app.use(express.json({ limit: "1mb" }));

  app.get("/api/health", async (request, response) => {
    await repository.health();
    response.json({ status: "ok" });
  });

  app.get("/api/applications", async (request, response) => {
    response.json(await repository.list());
  });

  app.get("/api/applications/:id", async (request, response) => {
    const application = await repository.get(request.params.id);
    if (!application) return response.status(404).json({ error: "Application not found." });
    response.json(application);
  });

  app.put("/api/applications/:id", async (request, response) => {
    const validationError = validateApplication(request.params.id, request.body);
    if (validationError) return response.status(400).json({ error: validationError });
    try {
      response.json(await repository.save(request.body));
    } catch (error) {
      if (error instanceof InvalidStateTransitionError) {
        return response.status(409).json({ error: error.message });
      }
      throw error;
    }
  });

  app.get("/", (request, response) => response.sendFile(path.join(ROOT, "index.html")));
  for (const filename of ["app.js", "app.css", "workflow.js"]) {
    app.get(`/${filename}`, (request, response) => response.sendFile(path.join(ROOT, filename)));
  }
  app.get("/runtime-config.js", (request, response) => {
    response.type("application/javascript").send('window.MERIDIAN_API_BASE_URL = "/api";\n');
  });

  app.use((request, response) => {
    response.status(404).json({ error: "Not found." });
  });
  app.use((error, request, response, next) => {
    const status = error.status === 413 ? 413 : error instanceof SyntaxError && "body" in error ? 400 : 500;
    console.error("Onboarding API request failed.", error);
    response.status(status).json({
      error: status === 413 ? "Request body is too large." : status === 400 ? "Request body must contain valid JSON." : "Internal server error."
    });
  });

  return app;
}

async function start() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set. Run `npm run migrate` before starting the server.");
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const repository = createPostgresRepository(pool);
  try {
    await repository.health();
  } catch (error) {
    await pool.end();
    throw error;
  }
  const app = createApp(repository);
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || "127.0.0.1";
  const server = app.listen(port, host, () => console.log(`Merchant onboarding server listening at http://${host}:${port}.`));

  const shutdown = () => {
    server.close(async (error) => {
      if (error) {
        console.error("Could not close the HTTP server cleanly.", error);
        process.exitCode = 1;
      }
      try {
        await pool.end();
      } catch (poolError) {
        console.error("Could not close the PostgreSQL pool cleanly.", poolError);
        process.exitCode = 1;
      }
    });
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (require.main === module) {
  start().catch((error) => {
    console.error("Could not start the onboarding server.", error);
    process.exitCode = 1;
  });
}

module.exports = { createApp, validateApplication, InvalidStateTransitionError };
