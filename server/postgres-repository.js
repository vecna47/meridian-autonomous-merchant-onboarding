"use strict";

const workflow = require("../workflow");

class InvalidStateTransitionError extends Error {
  constructor(currentState, nextState) {
    super(`Invalid onboarding state transition: ${currentState} -> ${nextState}.`);
    this.name = "InvalidStateTransitionError";
    this.currentState = currentState;
    this.nextState = nextState;
  }
}

function createPostgresRepository(pool) {
  return {
    async health() {
      await pool.query("SELECT 1 FROM merchant_applications LIMIT 0");
    },

    async list() {
      const result = await pool.query(
        "SELECT application FROM merchant_applications ORDER BY submitted_at DESC, id"
      );
      return result.rows.map((row) => row.application);
    },

    async get(id) {
      const result = await pool.query(
        "SELECT application FROM merchant_applications WHERE id = $1",
        [id]
      );
      return result.rows[0]?.application || null;
    },

    async save(application) {
      const client = await pool.connect();
      let transactionStarted = false;
      try {
        await client.query("BEGIN");
        transactionStarted = true;
        const existing = await client.query(
          "SELECT status FROM merchant_applications WHERE id = $1 FOR UPDATE",
          [application.id]
        );
        const currentState = existing.rows[0]?.status;
        if (currentState && !workflow.canTransition(currentState, application.status)) {
          throw new InvalidStateTransitionError(currentState, application.status);
        }

        const values = [
          application.id,
          application.businessName,
          application.email,
          application.status,
          new Date(application.submittedAt),
          JSON.stringify(application)
        ];
        if (currentState) {
          await updateApplication(client, values);
        } else {
          const inserted = await client.query(
            `INSERT INTO merchant_applications
              (id, business_name, email, status, submitted_at, application, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb, now())
             ON CONFLICT (id) DO NOTHING
             RETURNING id`,
            values
          );
          if (!inserted.rows.length) {
            const concurrent = await client.query(
              "SELECT status FROM merchant_applications WHERE id = $1 FOR UPDATE",
              [application.id]
            );
            const concurrentState = concurrent.rows[0]?.status;
            if (!concurrentState) throw new Error("Application disappeared during a concurrent save.");
            if (!workflow.canTransition(concurrentState, application.status)) {
              throw new InvalidStateTransitionError(concurrentState, application.status);
            }
            await updateApplication(client, values);
          }
        }
        await client.query("COMMIT");
        transactionStarted = false;
        return application;
      } catch (error) {
        if (transactionStarted) {
          try {
            await client.query("ROLLBACK");
          } catch (rollbackError) {
            console.error("Could not roll back application update.", rollbackError);
          }
        }
        throw error;
      } finally {
        client.release();
      }
    }
  };
}

function updateApplication(client, values) {
  return client.query(
    `UPDATE merchant_applications SET
       business_name = $2,
       email = $3,
       status = $4,
       submitted_at = $5,
       application = $6::jsonb,
       updated_at = now()
     WHERE id = $1`,
    values
  );
}

module.exports = { createPostgresRepository, InvalidStateTransitionError };
