(() => {
  "use strict";

  const STORAGE_KEY = "meridian.onboarding.applications.v1";
  const CHECK_LABELS = { pan: "PAN verification", gst: "GST verification", bank: "Bank account", risk: "Risk screening" };
  const CHECK_ORDER = ["pan", "gst", "bank", "risk"];
  const EXCEPTION_STATES = new Set(["needs_information", "needs_review", "provisioning_failed", "rejected"]);
  const CLOSED_STATES = new Set(["approved", "rejected"]);
  const LOW_CONFIDENCE_THRESHOLD = 85;
  const HIGH_RISK_THRESHOLD = 70;
  const FUZZY_NAME_MATCH_THRESHOLD = 0.92;
  const MIN_FUZZY_NAME_LENGTH = 10;
  const MAX_PROVIDER_ATTEMPTS = 2;
  const RETRY_BASE_DELAY_MS = 500;
  const PROVIDER_TIMEOUT_MS = 6000;
  const DEMO_TIMEOUT_MS = 900;
  const LATE_CALLBACK_DELAY_MS = 2500;
  const PROVIDER_METRICS_WINDOW_MS = 24 * 60 * 60 * 1000;
  const MAX_DOCUMENT_SIZE_BYTES = 10 * 1024 * 1024;
  const MAX_PDF_PAGES = 5;
  const MAX_RENDER_DIMENSION = 2400;
  const PDF_RENDER_TIMEOUT_MS = 30_000;
  const SUPPORTED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/bmp"]);
  const SUPPORTED_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "bmp"]);
  const TESSERACT_MODULE_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.esm.min.js";
  const TESSERACT_WORKER_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/worker.min.js";
  const TESSERACT_CORE_URL = "https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0";
  const TESSERACT_LANGUAGE_URL = "https://tessdata.projectnaptha.com/4.0.0";
  const PDFJS_MODULE_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs";
  const PDFJS_WORKER_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs";
  const PDFJS_STANDARD_FONTS_URL = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/standard_fonts/";
  const STATE_LABELS = {
    submitted: "Submitted",
    verifying: "Verifying",
    ready_for_approval: "Ready for approval",
    needs_information: "Needs information",
    needs_review: "Needs review",
    approved: "Approved",
    rejected: "Rejected",
    provisioning_failed: "Provisioning failed"
  };
  const workflow = window.MeridianWorkflow;
  const BANK_CHANGE_STATES = new Set(["submitted", "needs_review", "ready_for_approval", "approved", "provisioning_failed"]);
  const $ = (selector) => document.querySelector(selector);
  const rowsEl = $("#application-rows");
  const detailEl = $("#detail-panel");
  const dialog = $("#application-dialog");
  const documentInput = $("#document-file");
  const extractionButton = $("#extract-document");
  const clearDocumentButton = $("#clear-document");
  const extractionStatus = $("#extraction-status");
  const confidenceSimulationField = $("#confidence-simulation-field");
  let selectedId = null;
  let searchTerm = "";
  let filterValue = "all";
  let documentExtraction = null;
  let extractingDocument = false;
  const timers = new Map();
  let applications = loadApplications();
  let backendEnabled = false;
  let backendWriteQueue = Promise.resolve();

  function makeId() {
    return `APP-${Math.random().toString(36).slice(2, 6).toUpperCase()}${Date.now().toString().slice(-3)}`;
  }

  function initialApplications() {
    const now = Date.now();
    return [
      {
        id: "APP-2026-0418", businessName: "Aster & Oak Studio", contactName: "Maya Patel", email: "maya@asterandoak.in",
        pan: "•••••1234F", gst: "27••••••••••1Z5", bankAccount: "•••• 4821", submittedAt: now - 1000 * 60 * 34,
        status: "submitted", document: { name: "aster-oak-registration.pdf", confidence: 96, fields: "6 fields extracted" },
        checks: { pan: "pending", gst: "pending", bank: "pending", risk: "pending" }, mid: null, audit: [], demoGstFailure: true, demoDuplicatePanCallback: true, demoProvisioningFailure: true
      },
      {
        id: "APP-2026-0417", businessName: "Morrow Goods", contactName: "Arjun Mehta", email: "arjun@morrowgoods.in",
        pan: "•••••2345G", gst: "29••••••••••1Z4", bankAccount: "•••• 1190", submittedAt: now - 1000 * 60 * 60 * 2,
        status: "submitted", document: { name: "morrow-tax-certificate.pdf", confidence: 72, fields: "4 of 6 fields extracted" },
        missing: ["A clearer bank proof is required"], checks: { pan: "passed", gst: "passed", bank: "pending", risk: "pending" },
        mid: null, audit: [], demoRiskTransientFailure: true
      },
      {
        id: "APP-2026-0416", businessName: "Lumen Health Collective", contactName: "Nina Rao", email: "nina@lumenhealth.in",
        pan: "•••••3456H", gst: "07••••••••••1Z3", bankAccount: "•••• 7734", submittedAt: now - 1000 * 60 * 60 * 27,
        status: "approved", document: { name: "lumen-business-proof.pdf", confidence: 99, fields: "6 fields extracted" },
        checks: { pan: "passed", gst: "passed", bank: "passed", risk: "passed" }, mid: "MID-684291", audit: []
      }
    ].map((app, index) => {
      app.audit = [{ at: app.submittedAt, message: "Application submitted with structured document payload." }];
      app.stateHistory = [{ state: "submitted", at: app.submittedAt }];
      if (app.status === "approved") {
        const readyAt = app.submittedAt + 1000 * 60 * 8;
        const approvedAt = app.submittedAt + 1000 * 60 * 11;
        app.stateHistory.push({ state: "ready_for_approval", at: readyAt });
        app.stateHistory.push({ state: app.status, at: approvedAt });
        app.audit.push({ at: approvedAt, message: `All checks passed. Merchant ID ${app.mid} created.` });
      }
      app.stateSince = app.stateHistory[app.stateHistory.length - 1].at;
      if (app.status === "submitted" && app.missing?.length) {
        routeForLowConfidence(app, app.submittedAt + 1000 * 60 * 8);
      }
      app._tone = index;
      return app;
    });
  }

  function ensureStateTracking(app) {
    const submittedAt = Number.isFinite(app.submittedAt) ? app.submittedAt : Date.now();
    const audit = Array.isArray(app.audit) ? app.audit : [];
    app.audit = audit;
    if (!Array.isArray(app.stateHistory)) {
      app.stateHistory = [{ state: "submitted", at: submittedAt }];
      const historicalException = audit.find((event) => /failed|information|review|escalat|invalidat/i.test(event.message || ""));
      if (historicalException && !EXCEPTION_STATES.has(app.status)) {
        app.stateHistory.push({ state: "needs_review", at: historicalException.at || submittedAt });
      }
      if (app.status !== app.stateHistory[app.stateHistory.length - 1].state) {
        const lastAuditAt = audit.reduce((latest, event) => Math.max(latest, Number(event.at) || submittedAt), submittedAt);
        app.stateHistory.push({ state: app.status, at: app.stateSince || lastAuditAt });
      }
      app.stateHistory.sort((left, right) => left.at - right.at);
    }
    if (!Number.isFinite(app.stateSince)) {
      const lastState = app.stateHistory[app.stateHistory.length - 1];
      app.stateSince = lastState ? lastState.at : submittedAt;
    }
  }

  function transitionState(app, nextState, enteredAt = Date.now()) {
    if (app.status === nextState) return true;
    if (!workflow.canTransition(app.status, nextState)) {
      const currentLabel = STATE_LABELS[app.status] || app.status;
      const nextLabel = STATE_LABELS[nextState] || nextState;
      console.error(`Invalid onboarding state transition for ${app.id}: ${currentLabel} -> ${nextLabel}.`);
      toast("That application action is not available in its current state.", true);
      return false;
    }
    app.status = nextState;
    app.stateSince = enteredAt;
    app.stateHistory = app.stateHistory || [];
    app.stateHistory.push({ state: nextState, at: enteredAt });
    return true;
  }

  function routeForLowConfidence(app, enteredAt = Date.now()) {
    if (!app.document || (!app.document.needsReview && app.document.confidence >= LOW_CONFIDENCE_THRESHOLD)) return false;
    if (app.document.needsReview && !app.missing?.length) {
      app.missing = ["No supported fields could be extracted. Provide a clearer document and confirm the business details."];
    }
    const hasMissingInformation = Array.isArray(app.missing) && app.missing.length > 0;
    const nextState = hasMissingInformation ? "needs_information" : "needs_review";
    if (!transitionState(app, nextState, enteredAt)) return false;
    app.reviewNote = app.document.needsReview
      ? "No supported fields could be extracted from the document. Request a clearer document and manually confirm the entered values."
      : `Document confidence is ${app.document.confidence}%, below the ${LOW_CONFIDENCE_THRESHOLD}% review threshold.`;
    app.audit.push({
      at: enteredAt,
      message: app.document.needsReview
        ? `Document extraction found no supported fields; routed to ${STATE_LABELS[nextState]} and requested a clearer document.`
        : `Low-confidence document extraction (${app.document.confidence}%) automatically routed to ${STATE_LABELS[nextState]}.`
    });
    return true;
  }

  function routeForDocumentConflicts(app, conflicts, enteredAt = Date.now()) {
    if (!conflicts.length) return false;
    const fieldLabels = { businessName: "business name", pan: "PAN", gst: "GSTIN", bankAccount: "bank account" };
    const labels = conflicts.map((key) => fieldLabels[key] || key);
    if (!transitionState(app, "needs_review", enteredAt)) return false;
    app.document.conflicts = conflicts;
    app.reviewNote = `The document values conflict with the application form for: ${labels.join(", ")}. Confirm the correct values before continuing.`;
    app.audit.push({
      at: enteredAt,
      message: `Document and form values conflict for ${labels.join(", ")}; routed to manual review.`
    });
    return true;
  }

  function normalizeBusinessName(value) {
    const words = String(value || "").normalize("NFKC").toLowerCase().replace(/&/g, " and ").match(/[\p{L}\p{N}]+/gu) || [];
    return words.join(" ");
  }

  function stringSimilarity(left, right) {
    if (!left || !right) return 0;
    if (left === right) return 1;
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
      const current = [leftIndex];
      for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
        const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
        current[rightIndex] = Math.min(
          current[rightIndex - 1] + 1,
          previous[rightIndex] + 1,
          previous[rightIndex - 1] + substitutionCost
        );
      }
      previous = current;
    }
    return 1 - previous[right.length] / Math.max(left.length, right.length);
  }

  function businessNameSimilarity(left, right) {
    const leftWords = left.split(" ");
    const rightWords = right.split(" ");
    const leftCompact = leftWords.join("");
    const rightCompact = rightWords.join("");
    if (Math.min(leftCompact.length, rightCompact.length) < MIN_FUZZY_NAME_LENGTH) return 0;
    const compactScore = stringSimilarity(leftCompact, rightCompact);
    const tokenOrderScore = stringSimilarity(leftWords.slice().sort().join(" "), rightWords.slice().sort().join(" "));
    return Math.max(compactScore, tokenOrderScore);
  }

  function findPotentialDuplicates(app) {
    const businessName = normalizeBusinessName(app.businessName);
    const email = String(app.email || "").trim().toLowerCase();
    return applications.flatMap((candidate) => {
      if (candidate.id === app.id) return [];
      const candidateName = normalizeBusinessName(candidate.businessName);
      const exactName = businessName && candidateName === businessName;
      const nameScore = businessNameSimilarity(businessName, candidateName);
      const fuzzyName = !exactName && nameScore >= FUZZY_NAME_MATCH_THRESHOLD;
      const sameEmail = email && String(candidate.email || "").trim().toLowerCase() === email;
      if (!exactName && !fuzzyName && !sameEmail) return [];
      let nameMatch = "";
      if (exactName) nameMatch = "business name";
      else if (fuzzyName) nameMatch = `similar business name (${Math.round(nameScore * 100)}% similar)`;
      const match = sameEmail && nameMatch
        ? `${nameMatch} and email`
        : sameEmail ? "email" : nameMatch;
      return [{
        id: candidate.id,
        businessName: candidate.businessName,
        match
      }];
    });
  }

  function routeForDuplicateReview(app, matches, enteredAt = Date.now()) {
    if (!matches.length) return false;
    if (!transitionState(app, "needs_review", enteredAt)) return false;
    app.possibleDuplicates = matches;
    app.reviewNote = "A possible duplicate matched an exact contact email or a similar business name. Confirm whether these applications belong to the same merchant before continuing.";
    if (app.document.needsReview) app.reviewNote += " Document extraction found no supported fields; request a clearer document.";
    else if (app.document.confidence < LOW_CONFIDENCE_THRESHOLD) app.reviewNote += ` Document confidence is also below the ${LOW_CONFIDENCE_THRESHOLD}% review threshold.`;
    app.audit.push({
      at: enteredAt,
      message: `Potential duplicate detected: ${matches.map((match) => `${match.businessName} (${match.id}), matched on ${match.match}`).join("; ")}.`
    });
    return true;
  }

  function normalizeApplications(records) {
    let changed = false;
    records.forEach((app) => {
      if (!Array.isArray(app.stateHistory) || !Number.isFinite(app.stateSince)) changed = true;
      ensureStateTracking(app);
      if (typeof app.demoRiskTransientFailure !== "boolean") {
        app.demoRiskTransientFailure = app.status !== "approved";
        changed = true;
      }
      if (app.id === "APP-2026-0418" && typeof app.demoProvisioningFailure !== "boolean") {
        app.demoProvisioningFailure = true;
        changed = true;
      }
      if (!Array.isArray(app.providerRequests)) {
        app.providerRequests = [];
        changed = true;
      }
      if (app.status === "verifying") {
        app.providerAttempts = app.providerAttempts || {};
        app.activeProviderRequests = {};
        CHECK_ORDER.forEach((key) => {
          if (["running", "retrying"].includes(app.checks[key])) {
            app.checks[key] = "pending";
            app.providerAttempts[key] = 0;
          }
        });
        app.providerRequests.forEach((request) => {
          if (request.outcome === "pending") request.outcome = "interrupted";
        });
        transitionState(app, CHECK_ORDER.every((key) => app.checks[key] === "passed") ? "ready_for_approval" : "submitted");
        app.audit.push({ at: Date.now(), message: "Browser session ended during provider checks; unfinished checks returned to pending." });
        changed = true;
      } else if (app.providerRequests.some((request) => request.outcome === "pending")) {
        app.providerRequests.forEach((request) => {
          if (request.outcome === "pending") request.outcome = "interrupted";
        });
        changed = true;
      }
      if (!app.activeProviderRequests) {
        app.activeProviderRequests = {};
        changed = true;
      }
    });
    return { applications: records, changed };
  }

  function loadApplications() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          const normalized = normalizeApplications(parsed);
          if (normalized.changed) localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized.applications));
          return normalized.applications;
        }
        throw new Error("Stored applications were not a list.");
      }
    } catch (error) {
      console.error("Could not load saved onboarding data.", error);
      toast("Saved data could not be loaded. A fresh demo queue was started.", true);
    }
    const seeded = initialApplications();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(seeded));
    } catch (error) {
      console.error("Could not save initial onboarding data.", error);
    }
    return seeded;
  }

  async function apiRequest(path, options) {
    const response = await window.fetch(`${window.MERIDIAN_API_BASE_URL}${path}`, options);
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `Backend request failed with status ${response.status}.`);
    return payload;
  }

  async function saveBackendApplication(application) {
    return apiRequest(`/applications/${encodeURIComponent(application.id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(application)
    });
  }

  async function initializeBackend() {
    const apiBaseUrl = window.MERIDIAN_API_BASE_URL;
    if (!apiBaseUrl || typeof window.fetch !== "function") {
      syncDocumentSelection();
      if (applications.length && !selectedId) selectedId = applications[0].id;
      renderAll();
      return;
    }

    const appShell = $(".app-shell");
    appShell.setAttribute("aria-busy", "true");
    appShell.setAttribute("inert", "");
    try {
      const savedApplications = await apiRequest("/applications");
      if (!Array.isArray(savedApplications)) throw new Error("Backend returned an invalid application list.");
      backendEnabled = true;
      if (savedApplications.length) {
        const normalized = normalizeApplications(savedApplications);
        applications = normalized.applications;
        if (normalized.changed) {
          for (const application of applications) await saveBackendApplication(application);
        }
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(applications));
        } catch (error) {
          console.error("Could not cache backend applications in this browser.", error);
          toast("Applications loaded from the backend, but the browser cache could not be updated.", true);
        }
      } else {
        for (const application of applications) await saveBackendApplication(application);
      }
    } catch (error) {
      backendEnabled = false;
      console.error("Could not load onboarding data from the backend.", error);
      toast("Backend unavailable. This session is using browser-local storage.", true);
    } finally {
      appShell.removeAttribute("inert");
      appShell.setAttribute("aria-busy", "false");
      syncDocumentSelection();
      if (!applications.some((application) => application.id === selectedId)) {
        selectedId = applications[0]?.id || null;
      }
      renderAll();
    }
  }

  function persist(changedApplication = null) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(applications));
    } catch (error) {
      console.error("Could not persist onboarding data.", error);
      toast("Changes could not be saved in this browser.", true);
    }
    if (!backendEnabled) return;
    const snapshots = (changedApplication ? [changedApplication] : applications)
      .map((application) => JSON.parse(JSON.stringify(application)));
    backendWriteQueue = backendWriteQueue.then(async () => {
      for (const application of snapshots) {
        await saveBackendApplication(application);
      }
    }).catch((error) => {
      backendEnabled = false;
      console.error("Could not persist onboarding data to the backend.", error);
      toast("Backend save failed. Changes remain only in this browser.", true);
    });
  }

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
  }

  function initials(name) {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  }

  function formatDate(value) {
    const date = new Date(value);
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
  }

  function formatTime(value) {
    return new Date(value).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  function statusClass(status) {
    if (status === "approved") return "status-approved";
    if (status === "needs_information" || status === "provisioning_failed" || status === "rejected") return status === "rejected" ? "status-rejected" : "status-info";
    if (status === "needs_review") return "status-review";
    return ["verifying", "ready_for_approval"].includes(status) ? "status-progress" : "status-review";
  }

  function checksSummary(app) {
    const done = CHECK_ORDER.filter((key) => app.checks[key] === "passed" || app.checks[key] === "failed").length;
    return `<strong>${done}/${CHECK_ORDER.length}</strong> complete`;
  }

  function visibleApplications() {
    return applications.filter((app) => {
      const searchMatch = `${app.businessName} ${app.id}`.toLowerCase().includes(searchTerm);
      const filterMatch = filterValue === "all" ||
        (filterValue === "in_progress" && ["submitted", "verifying", "ready_for_approval"].includes(app.status)) ||
        (filterValue === "needs_attention" && ["needs_information", "needs_review", "provisioning_failed", "rejected"].includes(app.status)) ||
        (filterValue === "approved" && app.status === "approved");
      return searchMatch && filterMatch;
    });
  }

  function formatDuration(milliseconds) {
    const minutes = Math.floor(Math.max(0, milliseconds) / 60000);
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    const remainingMinutes = minutes % 60;
    if (days) return `${days}d ${hours}h`;
    if (hours) return `${hours}h ${String(remainingMinutes).padStart(2, "0")}m`;
    return `${minutes}m`;
  }

  function formatLatency(milliseconds) {
    return milliseconds >= 1000 ? `${(milliseconds / 1000).toFixed(1)} s` : `${Math.round(milliseconds)} ms`;
  }

  function renderProviderMetrics(now = Date.now()) {
    const requests = applications.flatMap((app) => Array.isArray(app.providerRequests) ? app.providerRequests : []);
    const cutoff = now - PROVIDER_METRICS_WINDOW_MS;
    const recentResponses = requests.filter((request) => Number.isFinite(request.respondedAt) && request.respondedAt >= cutoff);
    const recentLatencies = recentResponses
      .map((request) => request.respondedAt - request.requestedAt)
      .filter((latency) => Number.isFinite(latency) && latency >= 0);
    const eligibleRequests = requests.filter((request) => !["cancelled", "interrupted"].includes(request.outcome));
    const completedRequests = eligibleRequests.filter((request) => Number.isFinite(request.respondedAt));

    $("#metric-provider-latency").textContent = recentLatencies.length
      ? formatLatency(recentLatencies.reduce((total, latency) => total + latency, 0) / recentLatencies.length)
      : "—";
    $("#metric-provider-latency-note").textContent = recentLatencies.length
      ? `Based on ${recentLatencies.length} callback${recentLatencies.length === 1 ? "" : "s"} in the last 24 hours`
      : "No callbacks in the last 24 hours";
    $("#metric-provider-throughput").textContent = recentResponses.length;
    $("#metric-provider-completion").textContent = eligibleRequests.length
      ? `${Math.round(completedRequests.length / eligibleRequests.length * 100)}%`
      : "—";
    $("#metric-provider-completion-note").textContent = eligibleRequests.length
      ? `${completedRequests.length} of ${eligibleRequests.length} eligible attempts returned a callback`
      : "No provider requests yet";

    $("#provider-breakdown").innerHTML = CHECK_ORDER.map((key) => {
      const providerRequests = requests.filter((request) => request.key === key);
      const eligible = providerRequests.filter((request) => !["cancelled", "interrupted"].includes(request.outcome));
      const responses = eligible.filter((request) => Number.isFinite(request.respondedAt));
      const recentProviderResponses = responses.filter((request) => request.respondedAt >= cutoff);
      const latencies = recentProviderResponses
        .map((request) => request.respondedAt - request.requestedAt)
        .filter((latency) => Number.isFinite(latency) && latency >= 0);
      const completion = eligible.length ? `${Math.round(responses.length / eligible.length * 100)}% complete` : "No eligible requests";
      const passRate = responses.length
        ? `${Math.round(responses.filter((request) => request.outcome === "passed").length / responses.length * 100)}% pass rate`
        : "No responses";
      const latency = latencies.length
        ? `${formatLatency(latencies.reduce((total, value) => total + value, 0) / latencies.length)} avg · 24h`
        : "No recent latency";
      return `<article class="provider-stat-card"><span>${esc(CHECK_LABELS[key])}</span><strong>${responses.length}/${eligible.length} responses</strong><small>${completion} · ${passRate} · ${latency}</small></article>`;
    }).join("");
  }

  function renderMetrics(now = Date.now()) {
    const activeApplications = applications.filter((app) => !CLOSED_STATES.has(app.status));
    const totalTimeInState = activeApplications.reduce((total, app) => total + Math.max(0, now - (app.stateSince || app.submittedAt)), 0);
    const exceptionCount = applications.filter((app) =>
      EXCEPTION_STATES.has(app.status) || (app.stateHistory || []).some((event) => EXCEPTION_STATES.has(event.state))
    ).length;

    $("#metric-total").textContent = applications.length;
    $("#metric-progress").textContent = applications.filter((app) => ["submitted", "verifying", "ready_for_approval"].includes(app.status)).length;
    $("#metric-attention").textContent = applications.filter((app) => ["needs_information", "needs_review", "provisioning_failed", "rejected"].includes(app.status)).length;
    $("#metric-approved").textContent = applications.filter((app) => app.status === "approved").length;
    $("#metric-time-in-state").textContent = activeApplications.length
      ? formatDuration(totalTimeInState / activeApplications.length)
      : "—";
    $("#metric-time-note").textContent = activeApplications.length
      ? `Across ${activeApplications.length} active application${activeApplications.length === 1 ? "" : "s"}`
      : "No active applications";
    $("#metric-exception-rate").textContent = applications.length
      ? `${Math.round(exceptionCount / applications.length * 100)}%`
      : "0%";
    $("#metric-exception-note").textContent = `${exceptionCount} of ${applications.length} application${applications.length === 1 ? "" : "s"} hit an exception`;
    renderProviderMetrics(now);
  }

  function renderQueue() {
    const visible = visibleApplications();
    renderMetrics();
    $("#nav-count").textContent = applications.filter((app) => ["needs_information", "needs_review", "provisioning_failed"].includes(app.status)).length;
    $("#queue-count").textContent = visible.length;
    $("#results-label").textContent = `Showing ${visible.length} of ${applications.length} applications`;
    rowsEl.innerHTML = visible.map((app) => `
      <tr data-id="${esc(app.id)}" class="${app.id === selectedId ? "selected" : ""}">
        <td><div class="merchant-cell"><span class="merchant-avatar tone-${app._tone ?? 0}">${esc(initials(app.businessName))}</span><span><span class="merchant-name">${esc(app.businessName)}</span><span class="merchant-id">${esc(app.id)}</span></span></div></td>
        <td>${esc(formatDate(app.submittedAt))}</td>
        <td><span class="status-pill ${statusClass(app.status)}">${esc(STATE_LABELS[app.status] || app.status)}</span></td>
        <td class="checks-cell">${checksSummary(app)}</td>
        <td><span class="row-arrow">›</span></td>
      </tr>`).join("");
    $("#empty-state").classList.toggle("hidden", visible.length > 0);
    if (selectedId && !applications.some((app) => app.id === selectedId)) selectedId = null;
    rowsEl.querySelectorAll("tr").forEach((row) => row.addEventListener("click", () => selectApplication(row.dataset.id)));
  }

  function selectApplication(id) {
    selectedId = id;
    renderQueue();
    renderDetail();
  }

  function checkIconState(status) {
    if (status === "passed") return ["✓", "passed", "Passed"];
    if (status === "failed") return ["!", "failed", "Failed"];
    if (status === "running") return ["↻", "running", "In progress"];
    if (status === "retrying") return ["↻", "retrying", "Retrying"];
    return ["·", "pending", "Pending"];
  }

  function renderDetail() {
    const app = applications.find((item) => item.id === selectedId);
    if (!app) {
      detailEl.innerHTML = `<div class="detail-empty"><span class="detail-empty-icon">↖</span><h2>Select an application</h2><p>Choose a merchant from the queue to review verification status, missing information, and recent activity.</p></div>`;
      return;
    }
    const allPassed = CHECK_ORDER.every((key) => app.checks[key] === "passed");
    const pending = CHECK_ORDER.some((key) => ["pending", "running", "retrying"].includes(app.checks[key]));
    const failedKeys = CHECK_ORDER.filter((key) => app.checks[key] === "failed");
    const checksHtml = CHECK_ORDER.map((key) => {
      const [symbol, css, statusResult] = checkIconState(app.checks[key]);
      const result = app.checkFailureReasons?.[key] === "timed_out" ? "Timed out" : statusResult;
      const providerName = key === "risk" ? "Risk API" : `${key.toUpperCase()} API`;
      const riskScoreLabel = key === "risk" && Number.isFinite(app.riskScore) && ["passed", "failed"].includes(app.checks[key])
        ? ` · score ${app.riskScore}/100`
        : "";
      return `<div class="check-item"><span class="check-icon ${css}">${symbol}</span><span class="check-copy"><span class="check-name">${CHECK_LABELS[key]}</span><span class="check-meta">Mock provider · ${providerName}${riskScoreLabel}</span></span><span class="check-result ${css}">${result}</span></div>`;
    }).join("");
    const extractedFromFile = ["browser-ocr", "pdf-text"].includes(app.document.source);
    const documentConflicts = app.document.conflicts || [];
    const extractedFields = [
      ["businessName", "Business name", app.businessName, "Form match"],
      ["pan", "PAN", app.pan || "Not provided", app.pan ? "Format valid · masked" : "Missing"],
      ["gst", "GSTIN", app.gst || "Not provided", app.gst ? "Format valid · masked" : "Missing"],
      ["bankAccount", "Bank account", app.bankAccount || "Not provided", app.bankAccount ? "Masked · verification pending" : "Missing"]
    ].map(([key, label, value, defaultValidation]) => {
      const fieldConfidence = app.document.fieldConfidence?.[key];
      const fieldMethod = app.document.fieldMethods?.[key];
      const validation = fieldMethod === "pdf-text"
        ? "PDF text layer · format checked"
        : fieldMethod === "ocr"
          ? `Found by OCR · ${fieldConfidence}% page confidence`
          : extractedFromFile ? "Not found in document · entered manually" : defaultValidation;
      const documentValue = app.document.conflictValues?.[key];
      const conflict = documentConflicts.includes(key)
        ? ` · form conflict${documentValue ? ` (document: ${documentValue})` : ""}`
        : "";
      return `<div class="extracted-row"><span class="extracted-label">${esc(label)}</span><strong>${esc(value)}</strong><span class="extracted-validation">${esc(`${validation}${conflict}`)}</span></div>`;
    }).join("");
    const duplicateMatches = (app.possibleDuplicates || []).map((match) => `<li>${esc(match.businessName)} (${esc(match.id)}) — matched on ${esc(match.match)}</li>`).join("");
    const alert = app.status === "needs_information"
      ? `<div class="alert-box"><strong>Additional information needed</strong>${(app.missing || ["Please provide the missing application information."]).map(esc).join("<br>")}<div class="alert-actions"><button class="button button-subtle button-small" data-action="resolve-info">Mark information received</button></div></div>`
      : failedKeys.length
        ? `<div class="alert-box danger"><strong>Verification needs attention</strong>${failedKeys.map((key) => app.checkFailureReasons?.[key] === "timed_out" ? `${CHECK_LABELS[key]} provider response timed out.` : `${CHECK_LABELS[key]} did not match the submitted details.`).join("<br>")}<div class="alert-actions"><button class="button button-subtle button-small" data-action="retry-failed">Retry failed checks</button><button class="button button-subtle button-small" data-action="review">Escalate to reviewer</button></div></div>`
        : app.status === "needs_review" || app.status === "provisioning_failed"
          ? `<div class="alert-box danger"><strong>${app.status === "provisioning_failed" ? "Merchant ID creation failed" : "Manual review required"}</strong>${esc(app.reviewNote || "An operator must review this application before it can proceed.")}${duplicateMatches ? `<div class="duplicate-matches"><strong>Possible existing applications</strong><ul>${duplicateMatches}</ul></div>` : ""}<div class="alert-actions">${app.status === "provisioning_failed" ? '<button class="button button-subtle button-small" data-action="provision">Retry merchant ID creation</button>' : '<button class="button button-subtle button-small" data-action="review-clear">Resolve review</button>'}</div></div>`
          : app.status === "approved"
            ? `<div class="alert-box" style="border-color:#d9ecdf;background:#f5fbf7;color:#44735a"><strong>Merchant is ready</strong>Merchant ID <b>${esc(app.mid || "pending")}</b> is active in this sandbox.</div>`
            : "";
    const canStart = ["submitted", "needs_information"].includes(app.status) && pending;
    const canRequestInfo = ["submitted", "needs_review", "ready_for_approval"].includes(app.status);
    const canChangeBank = BANK_CHANGE_STATES.has(app.status);
    const actions = app.status === "approved"
      ? `<button class="button button-subtle button-small" data-action="change-bank">Change bank details</button>`
      : app.status === "needs_information"
        ? `<button class="button button-primary button-small" data-action="resume-info">Resume verification</button>`
        : app.status === "verifying"
          ? `<button class="button button-primary button-small button-disabled" disabled>Callbacks in progress…</button>`
          : app.status === "provisioning_failed"
            ? `<button class="button button-subtle button-small" data-action="change-bank">Edit bank details</button>`
            : `<button class="button button-primary button-small ${canStart ? "" : "button-disabled"}" data-action="run-checks" ${canStart ? "" : "disabled"}>${allPassed ? "All checks passed" : "Run verification checks"} <span>→</span></button>
               ${canRequestInfo ? '<button class="button button-subtle button-small" data-action="need-info">Request information</button>' : ""}
               ${canChangeBank ? '<button class="button button-subtle button-small" data-action="change-bank">Edit bank details</button>' : ""}
               ${app.status === "ready_for_approval" ? '<button class="button button-subtle button-small" data-action="approve">Approve application</button>' : ""}`;
    detailEl.innerHTML = `
      <div class="detail-header"><div class="detail-title-row"><div class="detail-merchant"><span class="merchant-avatar tone-${app._tone ?? 0}">${esc(initials(app.businessName))}</span><div><div class="detail-name">${esc(app.businessName)}</div><div class="detail-id">${esc(app.id)}</div></div></div><button class="icon-button" type="button" aria-label="More application actions" title="Application actions">···</button></div>
      <div class="detail-date">Submitted ${esc(formatDate(app.submittedAt))} · ${esc(app.contactName || "Merchant contact")}</div><div class="detail-status"><span class="status-pill ${statusClass(app.status)}">${esc(STATE_LABELS[app.status])}</span>${app.mid ? ` <span class="merchant-id">MID ${esc(app.mid)}</span>` : ""}</div></div>
      <div class="section-block"><div class="section-heading"><h3>Verification checks</h3><span>${CHECK_ORDER.filter((key) => app.checks[key] === "passed").length} of ${CHECK_ORDER.length} passed</span></div><div class="check-list">${checksHtml}</div></div>
      <div class="section-block"><div class="section-heading"><h3>Submitted documents</h3><span>${extractedFromFile ? "Local extraction" : "Structured payload"}</span></div><div class="doc-summary"><span class="doc-icon">▤</span><span class="doc-copy"><strong>${esc(app.document.name)}</strong><span>${esc(app.document.fields)}</span></span><span class="confidence ${app.document.needsReview || app.document.confidence < 85 ? "low" : ""}">${app.document.confidence}%</span></div></div>
      <div class="section-block"><div class="section-heading"><h3>Extracted fields</h3><span>${app.document.needsReview || app.document.confidence < 85 ? "Review recommended" : "Confidence score"}</span></div><div class="extracted-fields">${extractedFields}</div></div>
      ${alert ? `<div class="section-block">${alert}</div>` : ""}
      <div class="detail-actions">${actions}</div>
      <div class="audit-section"><div class="section-heading"><h3>Audit trail</h3><span>${app.audit.length} events</span></div><div class="audit-list">${[...app.audit].reverse().map((event) => `<div class="audit-event"><span class="audit-dot"></span><span class="audit-copy">${esc(event.message)}<span class="audit-time">${esc(formatTime(event.at))} · ${esc(formatDate(event.at))}</span></span></div>`).join("")}</div></div>`;
    detailEl.querySelectorAll("[data-action]").forEach((button) => button.addEventListener("click", () => handleAction(button.dataset.action, app.id)));
  }

  function addAudit(app, message) {
    app.audit.push({ at: Date.now(), message });
    persist(app);
  }

  function handleAction(action, id) {
    const app = applications.find((item) => item.id === id);
    if (!app) return;
    if (action === "run-checks" && ["submitted", "needs_information"].includes(app.status)) {
      if (app.missing?.length) { toast("Resolve missing information before starting verification.", true); return; }
      startVerification(app);
    } else if (action === "retry-failed") {
      failedRetry(app);
    } else if (action === "need-info") {
      if (!["submitted", "needs_review", "ready_for_approval"].includes(app.status)) {
        toast("Request additional information after verification has paused.", true);
        return;
      }
      if (!transitionState(app, "needs_information")) return;
      app.missing = ["Please provide a clearer document or confirm the submitted business details."];
      addAudit(app, "Additional information requested by operator.");
      persist(app); renderAll(); toast("Information request recorded.");
    } else if (action === "resolve-info") {
      if (app.status !== "needs_information") return;
      app.missing = [];
      if (!transitionState(app, "submitted")) return;
      addAudit(app, "Merchant information received; application is ready for verification.");
      persist(app); renderAll(); toast("Missing information marked as received.");
    } else if (action === "resume-info") {
      if (app.status !== "needs_information") return;
      app.missing = [];
      if (!transitionState(app, "submitted")) return;
      addAudit(app, "Merchant information confirmed by operator.");
      persist(app); renderAll();
      startVerification(app);
    } else if (action === "approve") {
      approve(app);
    } else if (action === "review") {
      if (app.status !== "needs_review" || !transitionState(app, "needs_review")) return;
      app.reviewNote = "A failed provider match requires human review.";
      addAudit(app, "Application escalated to human review after a failed provider check.");
      persist(app); renderAll(); toast("Application added to the review queue.");
    } else if (action === "review-clear") {
      if (app.status !== "needs_review") return;
      if (CHECK_ORDER.some((key) => app.checks[key] === "failed")) {
        toast("Retry failed provider checks before clearing this review.", true);
        return;
      }
      app.reviewNote = "";
      addAudit(app, "Operator resolved the manual review.");
      if (CHECK_ORDER.every((key) => app.checks[key] === "passed")) {
        if (!transitionState(app, "ready_for_approval")) return;
        persist(app); renderAll();
        toast("Review resolved. The application is ready for approval.");
      } else {
        if (!transitionState(app, "submitted")) return;
        persist(app); renderAll();
        startVerification(app);
      }
    } else if (action === "change-bank") {
      changeBank(app);
    } else if (action === "provision") {
      createMerchantId(app);
    }
  }

  function startVerification(app) {
    if (app.status === "verifying") return;
    if (!["submitted", "needs_information"].includes(app.status)) {
      toast("Verification can only start from a submitted application.", true);
      return;
    }
    if (app.bankChanged) {
      app.checks.bank = "pending";
      app.checks.risk = "pending";
      if (app.checkFailureReasons) {
        delete app.checkFailureReasons.bank;
        delete app.checkFailureReasons.risk;
      }
      app.providerAttempts = app.providerAttempts || {};
      app.providerAttempts.bank = 0;
      app.providerAttempts.risk = 0;
      app.bankChanged = false;
      addAudit(app, "Bank details changed; bank and risk checks reset for re-verification.");
    }
    if (!transitionState(app, "verifying")) return;
    const toRun = CHECK_ORDER.filter((key) => app.checks[key] === "pending");
    if (!toRun.length) {
      const nextState = CHECK_ORDER.every((key) => app.checks[key] === "passed") ? "ready_for_approval" : "needs_review";
      if (!transitionState(app, nextState)) return;
      persist(app);
      renderAll();
      return;
    }
    addAudit(app, `Verification requested from ${toRun.length} mock providers.`);
    toRun.forEach((key) => { app.checks[key] = "running"; });
    toRun.forEach((key, index) => {
      scheduleProviderAttempt(app.id, key, 700 + index * 480);
    });
    persist(app); renderAll();
    toast("Verification requests sent. Provider callbacks will arrive shortly.");
  }

  function scheduleProviderAttempt(appId, key, delay) {
    const app = applications.find((item) => item.id === appId);
    if (!app || app.status !== "verifying" || app.checks[key] !== "running") return;
    app.providerAttempts = app.providerAttempts || {};
    app.providerAttempts[key] = (app.providerAttempts[key] || 0) + 1;
    app.callbackAttempts = app.callbackAttempts || {};
    app.callbackAttempts[key] = (app.callbackAttempts[key] || 0) + 1;
    const attempt = app.providerAttempts[key];
    const eventId = `${app.id}:${key}:${app.callbackAttempts[key]}`;
    const shouldArriveLate = app.demoLateCallback && key === "bank" && attempt === 1;
    const timeoutDelay = shouldArriveLate ? DEMO_TIMEOUT_MS : PROVIDER_TIMEOUT_MS;
    const callbackDelay = shouldArriveLate ? Math.max(delay + LATE_CALLBACK_DELAY_MS, timeoutDelay + 1) : delay;
    const requestedAt = Date.now();
    app.providerRequests = app.providerRequests || [];
    app.activeProviderRequests = app.activeProviderRequests || {};
    app.activeProviderRequests[key] = eventId;
    app.providerRequests.push({
      eventId, key, attempt, requestedAt, timeoutAt: requestedAt + timeoutDelay, respondedAt: null, outcome: "pending"
    });
    const callbackTimerKey = providerTimerKey(app.id, key, eventId, "callback");
    const callbackTimer = setTimeout(() => {
      timers.delete(callbackTimerKey);
      const current = applications.find((item) => item.id === appId);
      if (!current) return;
      const result = mockProviderResult(current, key, attempt);
      handleProviderCallback(current.id, key, eventId, result, attempt);
      if (key === "pan" && current.demoDuplicatePanCallback) {
        current.demoDuplicatePanCallback = false;
        handleProviderCallback(current.id, key, eventId, result, attempt);
      }
    }, callbackDelay);
    timers.set(callbackTimerKey, callbackTimer);
    const timeoutTimerKey = providerTimerKey(app.id, key, eventId, "timeout");
    const timeoutTimer = setTimeout(() => {
      timers.delete(timeoutTimerKey);
      handleProviderTimeout(app.id, key, eventId, timeoutDelay);
    }, timeoutDelay);
    timers.set(timeoutTimerKey, timeoutTimer);
  }

  function providerTimerKey(appId, key, eventId, kind) {
    return `${appId}:${key}:${eventId}:${kind}`;
  }

  function mockProviderResult(app, key, attempt) {
    if (key === "gst" && app.demoGstFailure) return "failed";
    if (key === "risk" && app.demoRiskTransientFailure && attempt === 1) return "transient_failure";
    return "passed";
  }

  function recordProviderResponse(app, eventId, outcome) {
    const request = (app.providerRequests || []).find((item) => item.eventId === eventId);
    if (!request || Number.isFinite(request.respondedAt)) return;
    request.respondedAt = Date.now();
    request.outcome = outcome;
  }

  function pauseVerificationForReview(app, auditMessage, preserveCallback = null) {
    for (const [timerKey, timer] of timers) {
      if (timerKey.startsWith(`${app.id}:`)) {
        if (preserveCallback && timerKey === providerTimerKey(app.id, preserveCallback.key, preserveCallback.eventId, "callback")) continue;
        clearTimeout(timer);
        timers.delete(timerKey);
      }
    }
    (app.providerRequests || []).forEach((request) => {
      if (request.outcome === "pending") request.outcome = "cancelled";
    });
    for (const key of CHECK_ORDER) {
      if (["running", "retrying"].includes(app.checks[key])) app.checks[key] = "pending";
    }
    app.activeProviderRequests = {};
    addAudit(app, auditMessage);
  }

  function handleProviderTimeout(appId, key, eventId, timeoutDelay) {
    const app = applications.find((item) => item.id === appId);
    const request = app?.providerRequests?.find((item) => item.eventId === eventId);
    if (!app || !request || request.outcome !== "pending") return;
    if (app.status !== "verifying" || app.checks[key] !== "running" || app.activeProviderRequests?.[key] !== eventId) {
      request.outcome = "cancelled";
      persist(app);
      return;
    }
    request.outcome = "timed_out";
    request.timedOutAt = Date.now();
    app.activeProviderRequests[key] = null;
    app.demoLateCallback = false;
    app.checks[key] = "failed";
    app.checkFailureReasons = app.checkFailureReasons || {};
    app.checkFailureReasons[key] = "timed_out";
    transitionState(app, "needs_review");
    app.reviewNote = `${CHECK_LABELS[key]} did not respond within ${timeoutDelay} ms. Any later callback for this request will be ignored; retry the check to continue.`;
    pauseVerificationForReview(app, `${CHECK_LABELS[key]} provider request timed out after ${timeoutDelay} ms.`, { key, eventId });
    persist(app); renderAll(); toast(`${CHECK_LABELS[key]} timed out and was routed to review.`, true);
  }

  function handleProviderCallback(appId, key, eventId, result, attempt) {
    const app = applications.find((item) => item.id === appId);
    if (!app) return;
    app.processedCallbackIds = app.processedCallbackIds || [];
    if (app.processedCallbackIds.includes(eventId)) {
      addAudit(app, `Duplicate ${CHECK_LABELS[key]} callback ignored (${eventId}).`);
      persist(app); renderAll();
      return;
    }
    app.processedCallbackIds.push(eventId);
    const request = (app.providerRequests || []).find((item) => item.eventId === eventId);
    const awaitingCallback = app.status === "verifying"
      && app.checks[key] === "running"
      && app.activeProviderRequests?.[key] === eventId
      && request?.outcome === "pending";
    const timeoutTimerKey = providerTimerKey(app.id, key, eventId, "timeout");
    const timeoutTimer = timers.get(timeoutTimerKey);
    if (timeoutTimer) clearTimeout(timeoutTimer);
    timers.delete(timeoutTimerKey);
    if (awaitingCallback) {
      delete app.activeProviderRequests[key];
    } else if (request?.timedOutAt) {
      request.lateCallbackAt = Date.now();
    }
    recordProviderResponse(app, eventId, awaitingCallback ? result : "late_ignored");
    if (!awaitingCallback) {
      addAudit(app, request?.timedOutAt
        ? `Late ${CHECK_LABELS[key]} callback ignored after timeout (${eventId}); it did not change the check or application state.`
        : `Late ${CHECK_LABELS[key]} callback ignored (${eventId}); application is no longer awaiting this check.`);
      persist(app); renderAll();
      return;
    }
    if (result === "transient_failure" && attempt < MAX_PROVIDER_ATTEMPTS) {
      const retryDelay = RETRY_BASE_DELAY_MS * (2 ** (attempt - 1));
      app.checks[key] = "retrying";
      addAudit(app, `${CHECK_LABELS[key]} callback returned a temporary error; retry ${attempt + 1}/${MAX_PROVIDER_ATTEMPTS} scheduled in ${retryDelay} ms.`);
      const timerKey = `${app.id}:${key}:retry`;
      const timer = setTimeout(() => {
        const current = applications.find((item) => item.id === appId);
        timers.delete(timerKey);
        if (!current || current.status !== "verifying" || current.checks[key] !== "retrying") return;
        current.checks[key] = "running";
        scheduleProviderAttempt(current.id, key, 700);
        persist(current); renderAll();
      }, retryDelay);
      timers.set(timerKey, timer);
      persist(app); renderAll();
      return;
    }
    const passed = result === "passed";
    app.checks[key] = passed ? "passed" : "failed";
    addAudit(app, passed
      ? `${CHECK_LABELS[key]} callback received: passed.`
      : result === "transient_failure"
        ? `${CHECK_LABELS[key]} callback received a temporary error; retry limit of ${MAX_PROVIDER_ATTEMPTS} attempts exhausted.`
        : `${CHECK_LABELS[key]} callback received: failed: registered details did not match.`);
    if (!passed) {
      transitionState(app, "needs_review");
      app.reviewNote = result === "transient_failure"
        ? `${CHECK_LABELS[key]} remained unavailable after ${MAX_PROVIDER_ATTEMPTS} attempts. Retry the provider check or route to a reviewer.`
        : `${CHECK_LABELS[key]} did not match. Retry the provider check or route to a reviewer.`;
      pauseVerificationForReview(app, "Verification paused after mismatch; remaining provider requests were cancelled.");
    } else if (key === "risk" && app.riskScore >= HIGH_RISK_THRESHOLD) {
      transitionState(app, "needs_review");
      app.reviewNote = `Risk score ${app.riskScore}/100 met the high-risk threshold of ${HIGH_RISK_THRESHOLD}. Human review is required before approval.`;
      addAudit(app, `Risk screening returned a high score (${app.riskScore}/100; threshold ${HIGH_RISK_THRESHOLD}).`);
      pauseVerificationForReview(app, "Verification paused for high-risk review; outstanding provider requests were cancelled.");
    } else if (CHECK_ORDER.every((checkKey) => app.checks[checkKey] === "passed")) {
      transitionState(app, "ready_for_approval");
      addAudit(app, "All verification checks passed; application is ready for approval.");
    }
    persist(app); renderAll();
  }

  function failedRetry(app) {
    if (app.status !== "needs_review") {
      toast("Failed checks can only be retried from manual review.", true);
      return;
    }
    const failed = CHECK_ORDER.filter((key) => app.checks[key] === "failed");
    if (!failed.length) return;
    if (!transitionState(app, "submitted")) return;
    app.providerAttempts = app.providerAttempts || {};
    failed.forEach((key) => {
      app.checks[key] = "pending";
      app.providerAttempts[key] = 0;
      if (app.checkFailureReasons) delete app.checkFailureReasons[key];
    });
    app.demoGstFailure = false;
    app.demoLateCallback = false;
    app.reviewNote = "";
    addAudit(app, `Operator retried ${failed.map((key) => CHECK_LABELS[key]).join(", ")}.`);
    persist(app); renderAll(); startVerification(app);
  }

  function approve(app) {
    if (app.status !== "ready_for_approval" || !CHECK_ORDER.every((key) => app.checks[key] === "passed")) {
      toast("Approval is blocked until every verification check passes and the application is ready.", true);
      return;
    }
    if (!transitionState(app, "approved")) return;
    addAudit(app, "Application approved by operator.");
    persist(app); renderAll();
    createMerchantId(app);
  }

  function createMerchantId(app) {
    if (!["approved", "provisioning_failed"].includes(app.status) || !CHECK_ORDER.every((key) => app.checks[key] === "passed")) {
      toast("Merchant ID creation is only available after approval and all checks passing.", true);
      return;
    }
    if (app.mid) { toast(`Merchant ID ${app.mid} is already active.`); return; }
    const provisioningAttempt = (app.provisioningAttempts || 0) + 1;
    if (app.demoProvisioningFailure && provisioningAttempt === 1) {
      if (!transitionState(app, "provisioning_failed")) return;
      app.provisioningAttempts = provisioningAttempt;
      app.reviewNote = "All checks passed and approval was recorded, but the simulated merchant-ID service is unavailable.";
      addAudit(app, "Merchant ID service failed after approval; safe to retry without duplicate creation.");
      persist(app); renderAll(); toast("Approval saved, but merchant ID creation failed. Retry is available.", true);
      return;
    }
    if (!transitionState(app, "approved")) return;
    app.provisioningAttempts = provisioningAttempt;
    app.mid = `MID-${Math.floor(100000 + Math.random() * 900000)}`;
    app.reviewNote = "";
    addAudit(app, `Merchant ID ${app.mid} created and payment capabilities enabled.`);
    persist(app); renderAll(); toast(`Merchant approved. ${app.mid} is ready.`);
  }

  function changeBank(app) {
    if (!BANK_CHANGE_STATES.has(app.status)) {
      toast("Bank details cannot be changed while verification is in progress.", true);
      return;
    }
    const value = window.prompt("Enter the updated bank account number (8–18 digits). Do not use a real account in this demo.", "");
    if (value === null) return;
    const normalized = value.replace(/\s+/g, "");
    if (!/^\d{8,18}$/.test(normalized)) { toast("Enter a bank account number with 8 to 18 digits.", true); return; }
    const hasOtherFailedChecks = ["pan", "gst"].some((key) => app.checks[key] === "failed");
    if (!transitionState(app, hasOtherFailedChecks ? "needs_review" : "submitted")) return;
    app.bankAccount = `•••• ${normalized.slice(-4)}`;
    app.checks.bank = "pending";
    app.checks.risk = "pending";
    app.mid = null;
    app.bankChanged = true;
    app.reviewNote = "";
    addAudit(app, "Bank details changed by operator; bank and risk verification invalidated.");
    persist(app); renderAll(); toast("Bank details updated. Bank and risk checks must be run again.");
  }

  function renderAll() {
    renderQueue();
    renderDetail();
  }

  function toast(message, error = false) {
    const region = $("#toast-region");
    const element = document.createElement("div");
    element.className = `toast${error ? " error" : ""}`;
    element.textContent = message;
    region.appendChild(element);
    setTimeout(() => element.remove(), 4200);
  }

  function setExtractionStatus(message, tone = "") {
    extractionStatus.textContent = message;
    extractionStatus.className = `extraction-status${tone ? ` ${tone}` : ""}`;
  }

  function documentKind(file) {
    const extension = file.name.split(".").pop().toLowerCase();
    if (file.type === "application/pdf" || extension === "pdf") return "pdf";
    if (SUPPORTED_IMAGE_TYPES.has(file.type) || SUPPORTED_IMAGE_EXTENSIONS.has(extension)) return "image";
    throw new Error("Unsupported file type. Choose a PDF, PNG, JPEG, WebP, or BMP image.");
  }

  function validateDocument(file) {
    if (!file) throw new Error("Choose a document file first.");
    if (file.size === 0) throw new Error("The selected document is empty.");
    if (file.size > MAX_DOCUMENT_SIZE_BYTES) throw new Error("The file is larger than the 10 MB limit.");
    return documentKind(file);
  }

  function normalizeComparedField(key, value) {
    if (key === "businessName") return normalizeBusinessName(value);
    if (key === "bankAccount") return String(value || "").replace(/\D/g, "");
    return String(value || "").replace(/[^a-z0-9]/gi, "").toUpperCase();
  }

  function maskDocumentField(key, value) {
    if (key === "pan") return `•••••${String(value).slice(-5)}`;
    if (key === "gst") return `${String(value).slice(0, 2)}••••••••••${String(value).slice(-3)}`;
    if (key === "bankAccount") return `•••• ${String(value).replace(/\D/g, "").slice(-4)}`;
    return value;
  }

  function readLabeledFields(text) {
    const patterns = {
      businessName: /(?:legal\s+)?(?:business|company|merchant)\s+name\s*[:#-]\s*([^\r\n]+)/i,
      pan: /(?:permanent\s+account\s+number|pan(?:\s*(?:no|number))?)\s*[:#-]?\s*([A-Z]{5}[0-9]{4}[A-Z])/i,
      gst: /(?:gstin|gst(?:\s*(?:no|number|id))?)\s*[:#-]?\s*([0-9]{2}[A-Z0-9]{13})/i,
      bankAccount: /(?:bank\s+)?(?:account|a\/c)\s*(?:number|no\.?|#)?\s*[:#-]?\s*([0-9][0-9\s-]{6,24}[0-9])/i
    };
    const fields = {};
    Object.entries(patterns).forEach(([key, pattern]) => {
      const match = text.match(pattern);
      if (!match) return;
      const value = key === "bankAccount"
        ? match[1].replace(/\D/g, "")
        : match[1].trim().replace(/\s{2,}/g, " ");
      if (value) fields[key] = key === "businessName" ? value : value.toUpperCase();
    });
    if (fields.businessName) fields.businessName = fields.businessName.slice(0, 100);
    if (fields.pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(fields.pan)) delete fields.pan;
    if (fields.gst && !/^[0-9]{2}[A-Z0-9]{13}$/.test(fields.gst)) delete fields.gst;
    if (fields.bankAccount && !/^[0-9]{8,18}$/.test(fields.bankAccount)) delete fields.bankAccount;
    return fields;
  }

  function setDocumentExtractionBusy(busy) {
    extractingDocument = busy;
    documentInput.disabled = busy;
    extractionButton.disabled = busy || !documentInput.files.length || Boolean(documentExtraction);
    clearDocumentButton.disabled = busy;
    const submitButton = $("#application-form button[type='submit']");
    submitButton.disabled = busy;
    submitButton.innerHTML = busy ? "Extracting…" : 'Submit application <span>→</span>';
  }

  function resetDocumentExtraction() {
    if (documentExtraction) {
      const inputs = {
        businessName: $("#application-form [name='businessName']"),
        pan: $("#application-form [name='pan']"),
        gst: $("#application-form [name='gst']"),
        bankAccount: $("#application-form [name='bankAccount']")
      };
      Object.entries(documentExtraction.fields).forEach(([key, extractedValue]) => {
        const input = inputs[key];
        if (input && normalizeComparedField(key, input.value) === normalizeComparedField(key, extractedValue)) {
          input.value = "";
        }
      });
    }
    documentExtraction = null;
    confidenceSimulationField.hidden = false;
  }

  function syncDocumentSelection() {
    resetDocumentExtraction();
    const file = documentInput.files[0];
    extractionButton.disabled = !file;
    clearDocumentButton.hidden = !file;
    clearDocumentButton.disabled = false;
    if (!file) {
      setExtractionStatus("Choose a document to extract fields locally in this browser.");
      return;
    }
    try {
      validateDocument(file);
      setExtractionStatus(`${file.name} selected. Select “Extract fields from document” to begin local extraction.`);
    } catch (error) {
      setExtractionStatus(error.message, "error");
    }
  }

  async function loadOcrWorker() {
    setExtractionStatus("Loading local OCR engine and English language data…");
    const tesseract = await import(TESSERACT_MODULE_URL);
    const { createWorker } = tesseract.default || tesseract;
    return createWorker("eng", 1, {
      workerPath: TESSERACT_WORKER_URL,
      corePath: TESSERACT_CORE_URL,
      langPath: TESSERACT_LANGUAGE_URL,
      logger: (message) => {
        if (message.status === "recognizing text" && Number.isFinite(message.progress)) {
          setExtractionStatus(`Recognizing text… ${Math.round(message.progress * 100)}%`);
        } else if (message.status) {
          setExtractionStatus(`OCR: ${message.status}…`);
        }
      }
    });
  }

  async function renderPdfPages(file, getWorker) {
    const pdfjs = await import(PDFJS_MODULE_URL);
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
    const pdf = await pdfjs.getDocument({
      data: await file.arrayBuffer(),
      standardFontDataUrl: PDFJS_STANDARD_FONTS_URL,
      useSystemFonts: true
    }).promise;
    const pageCount = pdf.numPages;
    if (pageCount > MAX_PDF_PAGES) {
      await pdf.destroy();
      throw new Error(`This PDF has ${pageCount} pages. The demo supports up to ${MAX_PDF_PAGES} pages per file.`);
    }
    const results = [];
    try {
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        setExtractionStatus(`Reading PDF page ${pageNumber} of ${pageCount}…`);
        const page = await pdf.getPage(pageNumber);
        let canvas;
        try {
          const textContent = await page.getTextContent();
          const embeddedText = textContent.items
            .map((item) => `${item.str || ""}${item.hasEOL ? "\n" : " "}`)
            .join("")
            .trim();
          if (embeddedText && Object.keys(readLabeledFields(embeddedText)).length) {
            results.push({ text: embeddedText, confidence: 100, source: "pdf-text" });
            continue;
          }
          const baseViewport = page.getViewport({ scale: 1 });
          const scale = Math.min(2, MAX_RENDER_DIMENSION / Math.max(baseViewport.width, baseViewport.height));
          const viewport = page.getViewport({ scale });
          canvas = document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (!context) throw new Error("The browser could not create a canvas for this PDF page.");
          setExtractionStatus(`Rendering scanned PDF page ${pageNumber} of ${pageCount}…`);
          const renderTask = page.render({ canvasContext: context, canvas, viewport, intent: "print" });
          let timeoutId;
          try {
            await Promise.race([
              renderTask.promise,
              new Promise((resolve, reject) => {
                timeoutId = window.setTimeout(
                  () => reject(new Error(`Rendering PDF page ${pageNumber} timed out. Try a smaller PDF or an image file.`)),
                  PDF_RENDER_TIMEOUT_MS
                );
              })
            ]);
          } catch (error) {
            renderTask.cancel();
            throw error;
          } finally {
            window.clearTimeout(timeoutId);
          }
          const worker = await getWorker();
          const { data } = await worker.recognize(canvas);
          if (!Number.isFinite(data.confidence)) throw new Error(`OCR did not return a confidence score for PDF page ${pageNumber}.`);
          results.push({ text: data.text, confidence: data.confidence, source: "ocr" });
        } finally {
          if (canvas) {
            canvas.width = 0;
            canvas.height = 0;
          }
          page.cleanup();
        }
      }
    } finally {
      await pdf.destroy();
    }
    return results;
  }

  async function renderImage(file, worker) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_RENDER_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      bitmap.close();
      throw new Error("The browser could not create a canvas for this image.");
    }
    try {
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      setExtractionStatus("Reading image text…");
      const { data } = await worker.recognize(canvas);
      if (!Number.isFinite(data.confidence)) throw new Error("OCR did not return a confidence score for this image.");
      return [{ text: data.text, confidence: data.confidence, source: "ocr" }];
    } finally {
      bitmap.close();
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  function findDocumentConflicts(extraction, values) {
    const currentValues = {
      businessName: values.get("businessName"),
      pan: values.get("pan"),
      gst: values.get("gst"),
      bankAccount: values.get("bankAccount")
    };
    return Object.keys(extraction.fields).filter((key) => (
      currentValues[key]
      && normalizeComparedField(key, currentValues[key]) !== normalizeComparedField(key, extraction.fields[key])
    ));
  }

  async function extractSelectedDocument() {
    const file = documentInput.files[0];
    let worker;
    try {
      const kind = validateDocument(file);
      setDocumentExtractionBusy(true);
      const getWorker = async () => {
        if (!worker) worker = await loadOcrWorker();
        return worker;
      };
      const pages = kind === "pdf"
        ? await renderPdfPages(file, getWorker)
        : await renderImage(file, await getWorker());
      const confidence = Math.round(pages.reduce((total, page) => total + page.confidence, 0) / pages.length);
      const fields = {};
      const fieldConfidence = {};
      const fieldMethods = {};
      pages.forEach((page) => {
        Object.entries(readLabeledFields(page.text)).forEach(([key, value]) => {
          if (fields[key]) return;
          fields[key] = value;
          fieldMethods[key] = page.source;
          if (page.source === "ocr") fieldConfidence[key] = Math.round(page.confidence);
        });
      });
      const needsReview = !Object.keys(fields).length;
      const source = pages.some((page) => page.source === "ocr") ? "browser-ocr" : "pdf-text";
      documentExtraction = { fields, fieldConfidence, fieldMethods, confidence, source, needsReview };
      confidenceSimulationField.hidden = true;
      const inputs = {
        businessName: $("#application-form [name='businessName']"),
        pan: $("#application-form [name='pan']"),
        gst: $("#application-form [name='gst']"),
        bankAccount: $("#application-form [name='bankAccount']")
      };
      Object.entries(fields).forEach(([key, value]) => {
        const input = inputs[key];
        if (!input.value.trim()) input.value = value;
      });
      const conflicts = findDocumentConflicts(documentExtraction, new FormData($("#application-form")));
      const foundFields = Object.keys(fields).length;
      const conflictMessage = conflicts.length
        ? ` Conflicts with entered form values: ${conflicts.map((key) => ({ businessName: "business name", pan: "PAN", gst: "GSTIN", bankAccount: "bank account" })[key]).join(", ")}; those entries were preserved.`
        : "";
      setExtractionStatus(
        needsReview
          ? `No supported labeled fields were found. Enter the required values manually; submission will request a clearer document. OCR confidence: ${confidence}%.`
          : `Extracted ${foundFields} of 4 supported fields. Overall extraction confidence: ${confidence}%.${conflictMessage} Review every value before submitting.`,
        needsReview || conflicts.length ? "warning" : "success"
      );
    } catch (error) {
      setExtractionStatus(error instanceof Error ? error.message : "Document extraction failed unexpectedly.", "error");
    } finally {
      try {
        if (worker) await worker.terminate();
      } catch (error) {
        setExtractionStatus(error instanceof Error ? `OCR worker cleanup failed: ${error.message}` : "OCR worker cleanup failed.", "error");
      } finally {
        setDocumentExtractionBusy(false);
      }
    }
  }

  $("#new-application").addEventListener("click", () => dialog.showModal());
  $("#close-dialog").addEventListener("click", () => { if (!extractingDocument) dialog.close(); });
  $("#cancel-dialog").addEventListener("click", () => { if (!extractingDocument) dialog.close(); });
  dialog.addEventListener("cancel", (event) => { if (extractingDocument) event.preventDefault(); });
  dialog.addEventListener("click", (event) => { if (event.target === dialog && !extractingDocument) dialog.close(); });
  $("#search-input").addEventListener("input", (event) => { searchTerm = event.target.value.trim().toLowerCase(); renderQueue(); });
  $("#status-filter").addEventListener("change", (event) => { filterValue = event.target.value; renderQueue(); });
  $("#refresh-queue").addEventListener("click", () => { renderAll(); toast("Application queue refreshed."); });
  document.querySelectorAll("[data-static-nav]").forEach((link) => link.addEventListener("click", (event) => {
    event.preventDefault();
    toast("This navigation item is not part of the onboarding demo.");
  }));
  documentInput.addEventListener("change", syncDocumentSelection);
  extractionButton.addEventListener("click", extractSelectedDocument);
  clearDocumentButton.addEventListener("click", () => {
    documentInput.value = "";
    syncDocumentSelection();
  });
  $("#application-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (extractingDocument) return;
    if (documentInput.files.length && !documentExtraction) {
      setExtractionStatus("Run document extraction successfully or remove the selected file before submitting.", "error");
      toast("The selected document has not been successfully extracted.", true);
      return;
    }
    if (!form.reportValidity()) return;
    const values = new FormData(form);
    const submittedAt = Date.now();
    const confidence = documentExtraction ? documentExtraction.confidence : Number(values.get("documentConfidence"));
    const documentConflicts = documentExtraction ? findDocumentConflicts(documentExtraction, values) : [];
    const conflictValues = documentExtraction
      ? Object.fromEntries(documentConflicts.map((key) => [key, maskDocumentField(key, documentExtraction.fields[key])]))
      : {};
    const extractedCount = documentExtraction ? Object.keys(documentExtraction.fields).length : 0;
    const documentName = documentExtraction ? documentInput.files[0].name : "merchant-submitted-details.json";
    const app = {
      id: makeId(),
      businessName: values.get("businessName").trim(),
      contactName: values.get("contactName").trim(),
      email: values.get("email").trim(),
      pan: `•••••${String(values.get("pan")).trim().toUpperCase().slice(-5)}`,
      gst: `${String(values.get("gst")).trim().slice(0, 2)}••••••••••${String(values.get("gst")).trim().slice(-3).toUpperCase()}`,
      bankAccount: `•••• ${String(values.get("bankAccount")).slice(-4)}`,
      submittedAt,
      stateSince: submittedAt,
      stateHistory: [{ state: "submitted", at: submittedAt }],
      status: "submitted",
      document: {
        name: documentName,
        confidence,
        source: documentExtraction ? documentExtraction.source : "structured",
        fieldConfidence: documentExtraction ? documentExtraction.fieldConfidence : {},
        fieldMethods: documentExtraction ? documentExtraction.fieldMethods : {},
        needsReview: Boolean(documentExtraction?.needsReview),
        conflicts: documentConflicts,
        conflictValues,
        fields: documentExtraction ? `${extractedCount} of 4 supported fields extracted` : "Structured application fields entered"
      },
      checks: { pan: "pending", gst: "pending", bank: "pending", risk: "pending" },
      riskScore: Number(values.get("riskScore")),
      mid: null,
      audit: [{
        at: submittedAt,
        message: documentExtraction
          ? "Application submitted after browser-local document extraction; the uploaded file and raw OCR text were not stored."
          : "Application submitted with structured document payload."
      }],
      _tone: applications.length % 5,
      demoGstFailure: false,
      demoRiskTransientFailure: true,
      demoDuplicatePanCallback: ["duplicate_pan", "duplicate_and_late_bank"].includes(values.get("callbackScenario")),
      demoLateCallback: ["late_bank_callback", "duplicate_and_late_bank"].includes(values.get("callbackScenario")),
      demoProvisioningFailure: values.get("provisioningScenario") === "fail_once"
    };
    const possibleDuplicates = findPotentialDuplicates(app);
    const routedToDuplicateReview = routeForDuplicateReview(app, possibleDuplicates, submittedAt);
    const routedToConflictReview = !routedToDuplicateReview && routeForDocumentConflicts(app, documentConflicts, submittedAt);
    const routedToReview = routedToDuplicateReview || routedToConflictReview || routeForLowConfidence(app);
    applications.unshift(app);
    persist(app);
    form.reset();
    syncDocumentSelection();
    dialog.close();
    selectApplication(app.id);
    toast(routedToDuplicateReview
      ? "A possible duplicate was found and routed to manual review."
      : routedToConflictReview
        ? "Document conflicts were found and routed to manual review."
      : routedToReview && app.status === "needs_information"
        ? "Application submitted; a clearer document is required before verification."
        : routedToReview
          ? "Application submitted and routed to manual review because extraction needs attention."
      : "Application submitted. Review the extracted fields and start verification.");
  });

  initializeBackend();
  setInterval(renderMetrics, 60_000);
})();
