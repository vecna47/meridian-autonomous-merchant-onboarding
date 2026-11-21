# Meridian Merchant Onboarding Demo

Meridian is a small, vanilla JavaScript browser prototype of a merchant onboarding operations console. It demonstrates how an application can move from document extraction and submission through asynchronous provider checks to human review or approval.

The project is intentionally a front-end vertical slice. It does not connect to real identity, tax, bank, risk, or merchant-provisioning services. All example data and provider responses are simulated.

## Contents

- [Features](#features)
- [Operational metrics](#operational-metrics)
- [Run locally](#run-locally)
- [Try the demo](#try-the-demo)
- [Workflow and state transitions](#workflow-and-state-transitions)
- [Application data and privacy](#application-data-and-privacy)
- [Project structure](#project-structure)
- [Validation](#validation)
- [Assumptions and limitations](#assumptions-and-limitations)
- [Future Works](#future-works)

## Features

- **Operator queue:** View seeded applications, search by merchant or application ID, filter by status, and open an application detail view.
- **New application form:** Submit a structured sample payload with business name, contact, PAN, GSTIN, and bank account fields. Browser form validation checks required fields and basic input formats.
- **Local document OCR:** Select a PDF or common image and extract labeled business, PAN, GSTIN, and bank-account fields in the browser. Review OCR confidence, validation status, and conflicts with entered form values.
- **Extracted-field review:** See the document name, OCR or manual-entry confidence, extracted business fields, and validation status.
- **Simulated verification providers:** Run PAN, GST, bank-account, and risk checks. Each check updates asynchronously after a short delay.
- **Explicit workflow states:** Submitted, verifying, needs information, needs review, ready for approval, approved, and provisioning failed are represented in the interface.
- **Exception handling:** Review missing information, retry failed or timed-out provider checks, change bank details, and recover incomplete checks after a page reload.
- **Transient provider retries:** Temporary errors are retried automatically with a visible retrying status, audit entries, exponential backoff, and a two-attempt limit. Permanent mismatches are not auto-retried.
- **Low-confidence routing:** Submissions below the 85% confidence threshold are routed to manual review; an application with known missing information goes to the needs-information state instead.
- **High-risk routing:** A simulated risk score at or above 70/100 passes the risk check but routes the application to human review before approval.
- **Possible duplicate detection:** New submissions are compared with existing applications by exact email and conservative fuzzy business-name matching. Candidates are shown to an operator and routed to review; they are never automatically rejected or merged.
- **Callback resilience:** Provider requests have timeouts; duplicate and late callbacks are idempotently ignored and recorded in the audit trail.
- **Approval and merchant ID:** Approval is only available after all four checks pass. Merchant ID creation is then simulated and recorded.
- **Audit trail and metrics:** Status counts, average time in the current state, exception rate, provider response latency, callback throughput, and request completion rates are tracked.
- **Responsive layout:** The queue and detail view adapt to narrower screens; the table scrolls within its panel on mobile.

## Operational metrics

- **Average time in state** is the arithmetic mean of the time spent in the current state by active applications. Approved and rejected applications are excluded. The value updates when application state changes and once per minute while the page is open.
- **Exception rate** is the percentage of all applications that have ever entered an exception state: needs information, needs review, provisioning failed, or rejected. Resolving an exception does not remove that application from the numerator.
- **Provider response latency** is the mean time from a simulated request being scheduled to its callback, using callbacks received in the last 24 hours.
- **Callback throughput** is the number of provider callbacks received in the last 24 hours. Provider cards also show per-provider pass rate and response latency.
- **Request completion** is the percentage of eligible recorded provider attempts that received a callback. Canceled and browser-interrupted requests are excluded; still-pending requests count as incomplete. Metrics are local to the current browser and are not a production SLA.

State-entry timestamps are stored with each application. Existing saved records that predate this metric are migrated using their current state and available audit events; historic durations that were never recorded can only be estimated.

## Run locally

No package installation or build step is required.

### Option 1: Open the file

Open `index.html` in a modern browser for the manual-entry demo. Browser behavior for `localStorage` on `file://` URLs varies, and local OCR requires the page to be served over HTTP.

### Option 2: Start a local static server

From the project directory, run:

```powershell
py -m http.server 8000
```

Then open [http://localhost:8000](http://localhost:8000). Document extraction requires an internet connection to load the pinned PDF.js/Tesseract.js libraries on demand; Tesseract's English language data is fetched when OCR is needed.

Python is only needed for this optional server command. The application has no package installation or build step. The OCR libraries and English language data are loaded from their CDNs only when extraction is requested. The page also imports DM Sans and Manrope from Google Fonts; if those fonts cannot be fetched, local sans-serif fallbacks are used.

## Try the demo

The initial queue contains three fictional applications:

### 1. Complete the exception-and-retry journey

1. Select **Aster & Oak Studio**.
2. Select **Run verification checks**. The four checks start and update through delayed callbacks.
3. The PAN callback is deliberately delivered twice. The second event is ignored and recorded as a duplicate.
4. The simulated GST provider returns a mismatch. The application moves to **Needs review**, and any still-running checks are returned to pending.
5. Select **Retry failed checks**. The second GST response passes.
6. When the application becomes **Ready for approval**, select **Approve application**. Approval is recorded, then the seeded merchant-ID service fails once.
7. Select **Retry merchant ID creation**. Provisioning succeeds without creating a duplicate ID.

The seeded application demonstrates PAN success, a duplicate PAN callback, GST failure followed by a successful retry, and approval followed by a recoverable provisioning failure.

### 2. Review missing information

1. Select **Morrow Goods**. The example has a lower document confidence score and missing bank proof.
2. Select **Mark information received** or **Resume verification** to continue the example workflow.
3. The existing PAN and GST results are retained; bank and risk checks are run. The first risk callback simulates a temporary provider error, visibly enters **Retrying**, and then succeeds on the second attempt.

### 3. Submit an application

1. Select **New application**.
2. Optionally select a PDF or PNG, JPEG, WebP, or BMP image (up to 10 MB; PDFs up to 5 pages), then choose **Extract fields from document**. PDFs with embedded text are read directly; scanned PDF pages and images use local OCR. Use clearly labeled lines such as `Business Name: Northstar Coffee Co.`, `PAN: ABCDE1234F`, `GSTIN: 27ABCDE1234F1Z5`, and `Account Number: 12345678`. The extractor supports English, typed text; it does not read handwriting.
3. Review the extracted values and enter the required contact name and email. If a form value conflicts with OCR, the entered value is preserved and the application is routed to manual review.
4. With no file selected, keep extraction confidence at **High · 98%** to follow the normal manual-entry path, or select **Low · 72%** to see the automatic manual-review route. With a file, the OCR score replaces this simulation.
5. For a low-confidence submission, review the extracted fields and select **Resolve review**. The app returns to verification; approval remains blocked until all provider checks pass.
6. On a high-confidence submission, the first risk response also simulates a transient error so the automatic retry can be observed.
7. To test high-risk routing, select **High risk · score 82/100**, submit, and run checks. The risk check passes, but the application moves to **Needs review** until an operator resolves the risk review.
8. Use **Provider callback scenario** to deliver a duplicate PAN callback or to make the bank request time out before its callback arrives. The timeout moves the application to review; the later callback is audited and ignored. Retry the failed bank check to continue.
9. Use **Merchant-ID provisioning** to make provisioning fail once on a new application; after all checks pass and approval is recorded, retry the merchant-ID creation action.

If you do not attach a file, the form acts as a structured payload and the confidence selector exercises the routing rule.

An unreadable or blurred document that yields no labeled fields can still be submitted after entering the required form values; it is routed to **Needs information** with a request for a clearer document. Partial low-confidence extraction and conflicts between extracted values and the form are routed to **Needs review**.

### 4. Review a possible duplicate

1. Select **New application**.
2. Enter **Aster & Oak Studios** as the business name or use its sample contact email, `maya@asterandoak.in`, with otherwise fictional, valid form details.
3. Submit the application. It moves to **Needs review** and shows the candidate application and match reason, including the name similarity score when applicable.
4. Review the match before selecting **Resolve review**. A match is a review signal only; it does not block or reject the application automatically.

### 5. Change bank details after verification

After the seeded Aster & Oak application is approved and provisioned, choose **Change bank details** and enter a fictional account number. The merchant ID is cleared, bank and risk checks are invalidated, and the application returns to verification. The full account number is not retained; only its last four digits are displayed and stored.

## Workflow and state transitions

| State | Meaning | Typical next step |
| --- | --- | --- |
| `submitted` | Application is in the queue and can start or resume checks. | Start verification or request more information. |
| `verifying` | At least one simulated provider check is in progress. | Wait for callbacks. |
| `needs_information` | An operator has requested additional details. | Record that information was received, then resume. |
| `needs_review` | A provider result, risk score, extraction confidence, or possible duplicate needs operator attention. | Review the reason, then resolve or retry as appropriate. |
| `ready_for_approval` | All four checks passed. | Approve the application. |
| `approved` | An operator approved the application. | Merchant ID is created by the simulated provisioning step. |
| `provisioning_failed` | Approval was recorded but simulated merchant-ID creation failed. | Retry provisioning without re-running checks. |

`rejected` is recognized as a status for display/filtering purposes, but the demo does not include a reject action.

Important transition rules:

- The four required checks are PAN, GST, bank account, and risk.
- Approval is blocked unless all four check statuses are `passed` and the application is `ready_for_approval`.
- A failed provider result moves the application to `needs_review`; it cannot be approved directly.
- Risk scores at or above 70/100 pass the risk provider check but move the application to `needs_review`. Approval stays blocked until an operator resolves the review and all required checks have passed.
- A transient provider error retries automatically up to two total attempts, using 500 ms exponential backoff before the retry. If the limit is exhausted, the check fails and the application moves to `needs_review`. This behavior is simulated for risk checks; the seeded GST mismatch remains a permanent failure for the manual-review walkthrough.
- Provider requests time out after six seconds in the normal simulation. The selectable late-bank-callback scenario uses a short timeout; the request is marked timed out, and its later callback is recorded as ignored. The active request ID must match before a callback can update a check, so a late callback cannot satisfy a newer retry.
- A new submission with an exact email match or a business-name similarity of at least 92% moves to `needs_review` and displays the candidate and match reason. Fuzzy matching is disabled for names shorter than 10 alphanumeric characters. Matching is a conservative review signal, not an automatic rejection or merge.
- A submission below the 85% confidence threshold moves to `needs_review`, unless missing information is already recorded, in which case it moves to `needs_information`. If OCR finds no supported fields, the application requests a clearer document. Resolving a confidence review does not bypass provider checks.
- Retrying a failed check leaves already-passed checks intact.
- Merchant-ID provisioning happens after approval; if the provisioning-failure branch is enabled, the application retains approval and exposes a safe retry.
- Changing bank details resets bank and risk checks and clears the existing merchant ID before re-verification.
- Callback event IDs and request outcomes are stored on the application. Repeated events are ignored; timed-out, canceled, or superseded callbacks cannot change check state and are recorded in the audit trail.
- If the page reloads during `verifying`, checks marked as running return to pending. If all checks had already passed, the application returns to `ready_for_approval`.

## Application data and privacy

Application records are stored in the browser's `localStorage` under:

```text
meridian.onboarding.applications.v1
```

Storage is browser- and origin-specific. Applications are not sent to a server, shared with another browser, or protected by user authentication.

PAN and GSTIN values are masked before they are stored. Bank account numbers are reduced to their last four digits. Business and contact details, application state, callback IDs, provider-attempt timestamps, and audit history remain in local storage. **Use fictional data only; do not enter real identity, tax, bank, or personal information.** Browser local storage is not a secure vault.

Selected files are read and processed in the browser; the file itself and raw OCR text are not uploaded to an application server or saved in local storage. The pinned OCR/PDF libraries and, when needed, English language data are downloaded from CDNs, so the browser makes requests to those CDN hosts. Extracted PAN/GSTIN are masked before storage, bank account values are reduced to their last four digits, and only masked document values are retained for conflicts. OCR is English-only and intended for fictional demo data.

Possible-duplicate detection compares normalized business names (including token-order variants) using a 92% similarity threshold and exact email addresses. Fuzzy name matching requires at least 10 alphanumeric characters. It does not compare PAN, GSTIN, or bank details, which are masked or intentionally excluded from matching.

To clear the demo data, open the browser developer console for the local demo and run:

```js
localStorage.removeItem("meridian.onboarding.applications.v1");
location.reload();
```

The sample queue will be recreated on reload.

## Project structure

| File | Purpose |
| --- | --- |
| `index.html` | Dashboard layout, queue, detail panel, application dialog, and page metadata. |
| `app.css` | Responsive visual styles, typography, spacing, and component states. |
| `app.js` | Sample data, local persistence, rendering, form validation, simulated callbacks, state transitions, and audit handling. |
| `README.md` | Setup guide, walkthrough, workflow description, and limitations. |

## Validation

Install the development dependency and run the automated browser-workflow tests with Node.js:

```powershell
npm install
npm test
```

The suite uses Node's built-in test runner and jsdom to exercise application submission, exception routing, asynchronous provider callbacks, approval gates, provisioning recovery, and bank-detail invalidation. Document OCR itself requires a real browser and is not covered by the automated suite.

The JavaScript syntax can also be checked directly:

```powershell
node --check app.js
```

The document extraction flow can be validated manually using the **Try the demo** steps above.

## Assumptions and limitations

- **Providers are mocked.** PAN, GST, bank, and risk checks are local simulations. There are no network calls to verification providers.
- **Callbacks are timers, not webhooks.** Delayed browser timers demonstrate asynchronous state changes and bounded in-page retries, but do not model delivery guarantees, signing, authentication, retries across processes, or a durable queue.
- **Document extraction is a bounded local OCR demo.** It supports labeled printed English text in PDFs of up to five pages and PNG/JPEG/WebP/BMP images up to 10 MB. PDF.js reads embedded PDF text and renders scanned pages; Tesseract.js performs OCR on scanned pages and images. A scanned PDF page that takes over 30 seconds to render fails with a visible error. Extraction is pattern-based, does not understand arbitrary layouts or handwriting, and does not verify that separate documents agree. OCR confidence is an engine estimate (page-level scores are shown for OCR fields), not a calibrated probability; embedded PDF text is assigned 100% extraction confidence and is not an OCR confidence score. The 85% review threshold is fixed; failed OCR must be retried or the file removed before manual submission.
- **Human review is an operator UI state.** Low-confidence, provider-exception, high-risk, and possible-duplicate cases can be routed to review, but there is no separate reviewer account, access control, assignment system, or multi-user coordination. The risk score is selected from a demo-only form option; it is not generated by a risk model.
- **Duplicate matching is a lightweight heuristic.** It compares exact emails and uses edit-distance similarity for business names; it does not establish identity, perform cross-document entity resolution, or compare identity/tax documents.
- **Persistence is local only.** `localStorage` is not a database and does not provide server-side transactions, concurrency control, backup, or production-grade audit integrity.
- **Operational reporting is local and simulated.** Provider latency and throughput are based on browser timers, and the dashboard does not provide production SLAs, cohort trends, alerting, or shared team reporting.
- **Provisioning is simulated.** Merchant ID creation and payment capability activation are represented by a generated demo ID.
- This is a demonstration of workflow behavior, not a production onboarding, compliance, or risk-decisioning system.

## Future Works

- Add a backend API and durable workflow engine with persisted callback events, idempotency keys, timeout handling, and a dead-letter queue.
- Add authenticated operator and reviewer roles, review assignments, and immutable audit events.
- Improve extraction with broader document layouts, more languages, calibrated field-level confidence, and cross-document consistency checks.
- Integrate provider adapters behind a shared interface and support configurable timeouts and provider-specific retry policies.
- Extend entity matching with verified identifiers, addresses, trading-name aliases, and cross-document evidence.
- Add cohort-level operational trends, alerting, and shared team reporting.
