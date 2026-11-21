"use strict";

const session = require("express-session");
const workflow = require("../workflow");
const { createApp, InvalidStateTransitionError } = require("../server");

const TEST_SESSION_SECRET = "test-session-secret-with-sufficient-length";

function createMemoryRepository() {
  const applications = new Map();
  const users = new Map();
  return {
    applications,
    users,
    async health() {},
    async list() {
      return [...applications.values()];
    },
    async get(id) {
      return applications.get(id) || null;
    },
    async save(application) {
      const current = applications.get(application.id);
      if (current && !workflow.canTransition(current.status, application.status)) {
        throw new InvalidStateTransitionError(current.status, application.status);
      }
      const saved = JSON.parse(JSON.stringify(application));
      applications.set(application.id, saved);
      return saved;
    },
    async getUserByEmail(email) {
      return users.get(email) || null;
    },
    async getUserById(id) {
      return [...users.values()].find((user) => user.id === id) || null;
    },
    async createUser(user) {
      users.set(user.email, user);
      return user;
    }
  };
}

function createTestApp(repository, options = {}) {
  return createApp({
    repository,
    sessionStore: new session.MemoryStore(),
    sessionSecret: TEST_SESSION_SECRET,
    ...options
  });
}

function sessionCookie(response) {
  const cookie = response.headers.get("set-cookie");
  assertCookie(cookie);
  return cookie.split(";")[0];
}

function assertCookie(cookie) {
  if (!cookie) throw new Error("Response did not set a session cookie.");
}

module.exports = { createMemoryRepository, createTestApp, sessionCookie };
