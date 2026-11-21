"use strict";

const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { Pool } = require("pg");

async function migrate() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set before running migrations.");
  }
  const migration = await readFile(
    path.join(__dirname, "..", "migrations", "001_create_applications.sql"),
    "utf8"
  );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await pool.query(migration);
    console.log("Database migration completed.");
  } finally {
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error("Database migration failed.", error);
  process.exitCode = 1;
});
