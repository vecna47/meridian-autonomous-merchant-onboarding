"use strict";

const express = require("express");
const { Pool } = require("pg");
const path = require("node:path");
const { randomBytes, timingSafeEqual } = require("node:crypto");
const session = require("express-session");
const connectPgSimple = require("connect-pg-simple");
const { rateLimit } = require("express-rate-limit");
const workflow = require("./workflow");
const { createPostgresRepository, InvalidStateTransitionError } = require("./server/postgres-repository");
const { hashPassword, verifyPassword } = require("./server/passwords");

const ROOT = __dirname;
const SESSION_COOKIE_NAME = "meridian.sid";
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000;
const APPLICATION_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const CHECK_STATES = new Set(["pending", "running", "retrying", "passed", "failed"]);
const REQUIRED_CHECKS = ["pan", "gst", "bank", "risk"];
const ALLOWED_ROLES = new Set(["admin", "operator", "reviewer"]);
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

function saveSession(request) {
  return new Promise((resolve, reject) => {
    request.session.save((error) => error ? reject(error) : resolve());
  });
}

function regenerateSession(request) {
  return new Promise((resolve, reject) => {
    request.session.regenerate((error) => error ? reject(error) : resolve());
  });
}

function destroySession(request) {
  return new Promise((resolve, reject) => {
    request.session.destroy((error) => error ? reject(error) : resolve());
  });
}

function matchesToken(expected, supplied) {
  if (typeof expected !== "string" || typeof supplied !== "string") return false;
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  return expectedBuffer.length === suppliedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer);
}

function canUpdateApplication(user, current, next) {
  if (user.role !== "operator") return true;
  if (next.status === "approved" && current.status !== "approved") return false;
  if (current.status === "needs_review" && next.status === "ready_for_approval") return false;
  if (next.mid !== current.mid) return false;
  if (
    (next.pan !== current.pan || next.gst !== current.gst || next.bankAccount !== current.bankAccount)
    && !["submitted", "needs_review"].includes(current.status)
  ) return false;
  if (current.status === "approved" && current.mid && next.status === "submitted") return false;
  if (
    current.status === "needs_review"
    && next.status === "submitted"
    && !REQUIRED_CHECKS.some((key) => current.checks[key] === "failed")
  ) return false;
  return true;
}

function createApp({ repository, sessionStore, sessionSecret, secureCookies = false, trustProxy = false } = {}) {
  if (!repository) throw new Error("An application repository is required.");
  if (!sessionStore) throw new Error("A persistent session store is required.");
  if (typeof sessionSecret !== "string" || sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters.");
  }
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", trustProxy);
  app.use((request, response, next) => {
    response.set("X-Content-Type-Options", "nosniff");
    response.set("Referrer-Policy", "strict-origin-when-cross-origin");
    response.set("X-Frame-Options", "DENY");
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  app.use(session({
    name: SESSION_COOKIE_NAME,
    store: sessionStore,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: secureCookies,
      maxAge: SESSION_MAX_AGE_MS,
      path: "/"
    }
  }));

  app.get("/api/health", async (request, response) => {
    await repository.health();
    response.json({ status: "ok" });
  });

  app.get("/api/session", async (request, response) => {
    let user = null;
    if (request.session.userId) {
      const account = await repository.getUserById(request.session.userId);
      if (!account || !account.active) {
        await regenerateSession(request);
      } else {
        user = { id: account.id, email: account.email, role: account.role };
      }
    }
    if (!request.session.csrfToken) request.session.csrfToken = randomBytes(32).toString("base64url");
    await saveSession(request);
    response.json({ authenticated: Boolean(user), user, csrfToken: request.session.csrfToken });
  });

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (request, response) => response.status(429).json({ error: "Too many sign-in attempts. Try again later." })
  });
  const requireCsrf = (request, response, next) => {
    const origin = request.get("origin");
    const sameOrigin = !origin || origin === `${request.protocol}://${request.get("host")}`;
    if (!sameOrigin || !matchesToken(request.session.csrfToken, request.get("x-csrf-token"))) {
      return response.status(403).json({ error: "Request could not be verified." });
    }
    next();
  };
  const requireAuthenticated = async (request, response, next) => {
    if (!request.session.userId) return response.status(401).json({ error: "Authentication required." });
    const account = await repository.getUserById(request.session.userId);
    if (!account || !account.active || !ALLOWED_ROLES.has(account.role)) {
      await destroySession(request);
      return response.status(401).json({ error: "Authentication required." });
    }
    request.authUser = { id: account.id, email: account.email, role: account.role };
    next();
  };
  const dummyPasswordHashPromise = hashPassword(randomBytes(32).toString("base64url"));

  app.post("/api/auth/login", loginLimiter, requireCsrf, async (request, response) => {
    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length > 128) {
      return response.status(400).json({ error: "Enter a valid email address and password." });
    }
    const account = await repository.getUserByEmail(email);
    const passwordHash = account?.passwordHash || await dummyPasswordHashPromise;
    const passwordMatches = await verifyPassword(password, passwordHash);
    if (!account || !account.active || !passwordMatches) {
      return response.status(401).json({ error: "Email or password is incorrect." });
    }
    await regenerateSession(request);
    request.session.userId = account.id;
    request.session.csrfToken = randomBytes(32).toString("base64url");
    await saveSession(request);
    response.json({
      authenticated: true,
      user: { id: account.id, email: account.email, role: account.role },
      csrfToken: request.session.csrfToken
    });
  });

  app.post("/api/auth/logout", requireAuthenticated, requireCsrf, async (request, response) => {
    await destroySession(request);
    response.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      sameSite: "lax",
      secure: secureCookies,
      path: "/"
    });
    response.status(204).end();
  });

  app.get("/api/applications", requireAuthenticated, async (request, response) => {
    response.json(await repository.list());
  });

  app.get("/api/applications/:id", requireAuthenticated, async (request, response) => {
    const application = await repository.get(request.params.id);
    if (!application) return response.status(404).json({ error: "Application not found." });
    response.json(application);
  });

  app.put("/api/applications/:id", requireAuthenticated, requireCsrf, async (request, response) => {
    const validationError = validateApplication(request.params.id, request.body);
    if (validationError) return response.status(400).json({ error: validationError });
    try {
      const current = await repository.get(request.params.id);
      if (current && !canUpdateApplication(request.authUser, current, request.body)) {
        return response.status(403).json({ error: "Your role cannot perform this application action." });
      }
      if (
        !current
        && request.authUser.role === "operator"
        && !["submitted", "needs_information", "needs_review"].includes(request.body.status)
      ) {
        return response.status(403).json({ error: "Operators can only create applications that have not entered verification." });
      }
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
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    throw new Error("SESSION_SECRET must contain at least 32 characters.");
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const repository = createPostgresRepository(pool);
  try {
    await repository.health();
  } catch (error) {
    await pool.end();
    throw error;
  }
  const PgSessionStore = connectPgSimple(session);
  const sessionStore = new PgSessionStore({
    pool,
    tableName: "merchant_sessions",
    createTableIfMissing: false,
    pruneSessionInterval: 15 * 60
  });
  const app = createApp({
    repository,
    sessionStore,
    sessionSecret: process.env.SESSION_SECRET,
    secureCookies: process.env.NODE_ENV === "production",
    trustProxy: process.env.TRUST_PROXY === "1"
  });
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
