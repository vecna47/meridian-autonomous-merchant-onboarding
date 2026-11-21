"use strict";

const { promisify } = require("node:util");
const { randomBytes, scrypt: scryptCallback, timingSafeEqual } = require("node:crypto");

const scrypt = promisify(scryptCallback);
const KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function validatePassword(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 128) {
    throw new Error("Password must be between 12 and 128 characters.");
  }
}

async function hashPassword(password) {
  validatePassword(password);
  const salt = randomBytes(16);
  const derivedKey = await scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);
  return `scrypt$${salt.toString("base64url")}$${derivedKey.toString("base64url")}`;
}

async function verifyPassword(password, storedHash) {
  if (typeof password !== "string" || password.length > 128 || typeof storedHash !== "string") return false;
  const parts = storedHash.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "base64url");
  const expectedKey = Buffer.from(parts[2], "base64url");
  if (salt.length !== 16 || expectedKey.length !== KEY_LENGTH) return false;
  const actualKey = await scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS);
  return timingSafeEqual(actualKey, expectedKey);
}

module.exports = { hashPassword, verifyPassword, validatePassword };
