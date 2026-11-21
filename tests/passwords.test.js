"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { hashPassword, verifyPassword, validatePassword } = require("../server/passwords");

test("passwords are scrypt-hashed and verification rejects wrong or malformed values", async () => {
  const password = "correct-horse-battery";
  const storedHash = await hashPassword(password);

  assert.match(storedHash, /^scrypt\$/);
  assert.notEqual(storedHash, password);
  assert.equal(await verifyPassword(password, storedHash), true);
  assert.equal(await verifyPassword("incorrect-password", storedHash), false);
  assert.equal(await verifyPassword(password, "invalid"), false);
  assert.equal(await verifyPassword(password, `scrypt$${"a".repeat(32)}$${"b".repeat(128)}`), false);
  assert.throws(() => validatePassword("short"), /12 and 128/);
});
