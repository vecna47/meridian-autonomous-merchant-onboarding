"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createPostgresRepository, InvalidStateTransitionError } = require("../server/postgres-repository");

function applicationRecord(status) {
  const submittedAt = Date.now();
  return {
    id: "APP-POSTGRES-1",
    businessName: "Example Merchant",
    email: "merchant@example.test",
    submittedAt,
    status,
    stateHistory: [{ state: status, at: submittedAt }]
  };
}

test("PostgreSQL repository locks and validates state changes transactionally", async () => {
  const statuses = new Map();
  const statements = [];
  let releaseCount = 0;
  const client = {
    async query(sql, values = []) {
      statements.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("SELECT status FROM merchant_applications")) {
        const status = statuses.get(values[0]);
        return { rows: status ? [{ status }] : [] };
      }
      if (sql.includes("INSERT INTO merchant_applications")) {
        if (statuses.has(values[0])) return { rows: [] };
        statuses.set(values[0], values[3]);
        return { rows: [{ id: values[0] }] };
      }
      if (sql.includes("UPDATE merchant_applications SET")) {
        statuses.set(values[0], values[3]);
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL in repository test: ${sql}`);
    },
    release() {
      releaseCount += 1;
    }
  };
  const repository = createPostgresRepository({ connect: async () => client });

  await repository.save(applicationRecord("submitted"));
  await repository.save(applicationRecord("needs_review"));
  await assert.rejects(
    repository.save(applicationRecord("approved")),
    InvalidStateTransitionError
  );

  assert.equal(statuses.get("APP-POSTGRES-1"), "needs_review");
  assert.equal(statements.filter((statement) => statement === "BEGIN").length, 3);
  assert.equal(statements.filter((statement) => statement === "COMMIT").length, 2);
  assert.equal(statements.filter((statement) => statement === "ROLLBACK").length, 1);
  assert.equal(releaseCount, 3);
});
