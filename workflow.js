"use strict";

(function exposeWorkflow(global) {
  const allowedTransitions = Object.freeze({
    submitted: Object.freeze(["verifying", "needs_information", "needs_review"]),
    verifying: Object.freeze(["submitted", "ready_for_approval", "needs_review"]),
    needs_information: Object.freeze(["submitted", "verifying"]),
    needs_review: Object.freeze(["needs_information", "submitted", "ready_for_approval"]),
    ready_for_approval: Object.freeze(["approved", "needs_information", "submitted"]),
    approved: Object.freeze(["provisioning_failed", "submitted"]),
    provisioning_failed: Object.freeze(["approved", "submitted"]),
    rejected: Object.freeze([])
  });

  const workflow = Object.freeze({
    allowedTransitions,
    canTransition(currentState, nextState) {
      return currentState === nextState || Boolean(allowedTransitions[currentState]?.includes(nextState));
    }
  });

  if (typeof module === "object" && module.exports) {
    module.exports = workflow;
  } else {
    global.MeridianWorkflow = workflow;
  }
})(globalThis);
