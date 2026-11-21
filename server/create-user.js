"use strict";

const { randomUUID } = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");
const { Pool } = require("pg");
const { createPostgresRepository } = require("./postgres-repository");
const { hashPassword, validatePassword } = require("./passwords");

const ALLOWED_ROLES = new Set(["admin", "operator", "reviewer"]);

function readArguments(argumentsList) {
  const options = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const key = argumentsList[index];
    if (!["--email", "--role"].includes(key) || !argumentsList[index + 1]) {
      throw new Error("Usage: npm run create-user -- --email user@example.com --role admin|operator|reviewer");
    }
    options[key.slice(2)] = argumentsList[index + 1];
  }
  const email = String(options.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Provide a valid email address.");
  if (!ALLOWED_ROLES.has(options.role)) throw new Error("Role must be admin, operator, or reviewer.");
  return { email, role: options.role };
}

function readSecret(promptText) {
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Create users from an interactive terminal so passwords are not echoed or passed as command arguments.");
  }
  return new Promise((resolve, reject) => {
    let value = "";
    const decoder = new StringDecoder("utf8");
    const finish = (error) => {
      input.removeListener("data", onData);
      input.setRawMode(false);
      input.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const character of decoder.write(chunk)) {
        if (character === "\u0003") return finish(new Error("Password entry cancelled."));
        if (character === "\r" || character === "\n") return finish();
        if (character === "\u007f" || character === "\b") {
          value = Array.from(value).slice(0, -1).join("");
        } else if (character >= " ") {
          value += character;
        }
      }
    };
    process.stdout.write(promptText);
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function createUser() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL must be set.");
  const { email, role } = readArguments(process.argv.slice(2));
  const password = await readSecret("Password (hidden, 12-128 characters): ");
  validatePassword(password);
  const confirmation = await readSecret("Confirm password: ");
  if (password !== confirmation) throw new Error("Passwords do not match.");

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const repository = createPostgresRepository(pool);
    const user = await repository.createUser({
      id: randomUUID(),
      email,
      passwordHash: await hashPassword(password),
      role
    });
    console.log(`Created ${user.role} account for ${user.email}.`);
  } finally {
    await pool.end();
  }
}

createUser().catch((error) => {
  console.error("Could not create user.", error);
  process.exitCode = 1;
});
