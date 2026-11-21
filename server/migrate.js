"use strict";

const { readFile, readdir } = require("node:fs/promises");
const path = require("node:path");
const { Pool } = require("pg");

async function migrate() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be set before running migrations.");
  }
  const migrationDirectory = path.join(__dirname, "..", "migrations");
  const migrationFiles = (await readdir(migrationDirectory))
    .filter((filename) => filename.endsWith(".sql"))
    .sort();
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    for (const filename of migrationFiles) {
      await pool.query(await readFile(path.join(migrationDirectory, filename), "utf8"));
      console.log(`Applied ${filename}.`);
    }
  } finally {
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error("Database migration failed.", error);
  process.exitCode = 1;
});
