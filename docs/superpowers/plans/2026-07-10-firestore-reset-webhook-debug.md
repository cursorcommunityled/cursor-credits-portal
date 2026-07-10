# Firestore Reset & Webhook Debug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Diagnose why Luma webhooks return HTTP 200 without populating attendees, then safely wipe and re-bootstrap production Firestore (`cursor-redeem-17668`) across `cursor-canela-intro` and `cursor-credits-portal`.

**Architecture:** Add structured, PII-free debug instrumentation to the canela-intro Luma webhook handler and an env audit script; add Firestore audit/export/reset scripts to credits-portal using `firebase-admin` for collection discovery and batched deletes. Operational phases (env fix, bootstrap, E2E) are manual runbook steps executed after diagnostics confirm the root cause.

**Tech Stack:** Next.js App Router, Firebase client SDK (apps), `firebase-admin` (credits-portal scripts only), Node ESM `.mjs` scripts, `node:test` for pure-function unit tests.

**Repos:**
- `cursor-canela-intro` — webhook instrumentation, `audit-env.mjs`
- `cursor-credits-portal` — `audit-firestore.mjs`, `export-firestore.mjs`, `reset-firestore.mjs`

**Prerequisite:** Service account JSON for `cursor-redeem-17668` with Firestore read/write. Set `GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json` before running credits-portal scripts.

---

## File Structure

### cursor-canela-intro (create/modify)

| File | Responsibility |
|------|----------------|
| `src/lib/debug/luma-webhook-log.ts` | PII-safe structured debug logger (console + optional NDJSON + optional ingest POST) |
| `src/lib/debug/luma-webhook-log.test.ts` | Unit tests for log payload sanitization |
| `src/app/api/webhooks/luma/route.ts` | Add debug calls at handler entry, post-verify, duplicate check, ignore branches, post-upsert |
| `scripts/audit-env.mjs` | Print resolved env vars; flag `SYNC_PROJECT_ID` vs `NEXT_PUBLIC_TEST_PROJECT_ID` drift |
| `scripts/lib/load-env.mjs` | Shared `.env` / `.env.local` loader (extracted from `migrate-project-id.mjs` pattern) |
| `.gitignore` | Add `logs/` |
| `env.example` | Document `LUMA_WEBHOOK_DEBUG`, `DEBUG_INGEST_URL` |
| `package.json` | Add `audit:env`, `test:debug-log` scripts |

### cursor-credits-portal (create/modify)

| File | Responsibility |
|------|----------------|
| `scripts/lib/load-env.mjs` | Shared env loader |
| `scripts/lib/firestore-admin.mjs` | Init `firebase-admin`, assert project ID, list collections |
| `scripts/lib/audit-helpers.mjs` | Pure functions: flag legacy markers (`@example.com`, `sample-event-1`) |
| `scripts/lib/audit-helpers.test.mjs` | Unit tests for audit helpers |
| `scripts/audit-firestore.mjs` | List projects, per-collection counts, legacy flags |
| `scripts/export-firestore.mjs` | Full JSON backup to `backups/YYYY-MM-DD-HHMM.json` |
| `scripts/reset-firestore.mjs` | Gated full wipe with auto-export |
| `.gitignore` | Add `backups/` |
| `package.json` | Add `firebase-admin` devDep; `audit:firestore`, `export:firestore`, `reset:firestore` scripts |

### Out of scope (per spec)

- Vitest / Playwright setup
- Firebase Emulator
- Porting webhook to credits-portal
- Removing `sample-event-1` legacy fallbacks in app code

---

## Phase 1 — Diagnostics (code tasks)

### Task 1: Luma webhook debug log helper (canela-intro)

**Files:**
- Create: `cursor-canela-intro/src/lib/debug/luma-webhook-log.ts`
- Create: `cursor-canela-intro/src/lib/debug/luma-webhook-log.test.ts`
- Modify: `cursor-canela-intro/package.json`
- Modify: `cursor-canela-intro/.gitignore`

- [ ] **Step 1: Write the failing test**

Create `src/lib/debug/luma-webhook-log.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sanitizeWebhookDebugPayload } from "./luma-webhook-log";

describe("sanitizeWebhookDebugPayload", () => {
  it("strips PII keys from payload", () => {
    const input = {
      hypothesis: "H5",
      email: "secret@example.com",
      user_name: "Jane Doe",
      projectId: "abc123",
      reason: "not_approved",
    };
    const out = sanitizeWebhookDebugPayload(input);
    assert.equal(out.projectId, "abc123");
    assert.equal(out.reason, "not_approved");
    assert.equal("email" in out, false);
    assert.equal("user_name" in out, false);
  });

  it("allows safe diagnostic fields", () => {
    const out = sanitizeWebhookDebugPayload({
      hypothesis: "H2",
      payloadEventId: "evt-wrong",
      configuredEventId: "evt-right",
      webhookIdPresent: true,
    });
    assert.deepEqual(out, {
      hypothesis: "H2",
      payloadEventId: "evt-wrong",
      configuredEventId: "evt-right",
      webhookIdPresent: true,
    });
  });
});
```

Add to `package.json` scripts:

```json
"test:debug-log": "node --import tsx --test src/lib/debug/luma-webhook-log.test.ts"
```

Add to `.gitignore`:

```
logs/
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `cursor-canela-intro`):

```bash
npm run test:debug-log
```

Expected: FAIL with module not found or `sanitizeWebhookDebugPayload` not defined.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/debug/luma-webhook-log.ts`:

```typescript
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const PII_KEYS = new Set([
  "email",
  "user_email",
  "user_name",
  "user_first_name",
  "user_last_name",
  "name",
  "attendeeName",
]);

export type WebhookHypothesis = "H1" | "H2" | "H3" | "H4" | "H5" | "entry" | "verify" | "duplicate" | "processed";

export function sanitizeWebhookDebugPayload(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (PII_KEYS.has(key)) continue;
    safe[key] = value;
  }
  return safe;
}

function isDebugEnabled(): boolean {
  return process.env.LUMA_WEBHOOK_DEBUG === "1";
}

async function appendNdjson(record: Record<string, unknown>): Promise<void> {
  const dir = join(process.cwd(), "logs");
  await mkdir(dir, { recursive: true });
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`;
  await appendFile(join(dir, "luma-webhook-debug.ndjson"), line, "utf8");
}

async function postIngest(record: Record<string, unknown>): Promise<void> {
  const url = process.env.DEBUG_INGEST_URL;
  if (!url) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
  } catch {
    // Fire-and-forget; never block webhook
  }
}

export async function logLumaWebhookDebug(
  step: string,
  payload: Record<string, unknown>,
): Promise<void> {
  if (!isDebugEnabled()) return;

  const record = sanitizeWebhookDebugPayload({
    step,
    ...payload,
  });

  console.info("[luma-webhook-debug]", JSON.stringify(record));

  await Promise.allSettled([
    appendNdjson(record),
    postIngest(record),
  ]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm run test:debug-log
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
cd /home/marcelo/dev/private/cursor-canela-intro
git add src/lib/debug/luma-webhook-log.ts src/lib/debug/luma-webhook-log.test.ts package.json .gitignore
git commit -m "feat: add PII-safe Luma webhook debug logger"
```

---

### Task 2: Instrument webhook route (canela-intro)

**Files:**
- Modify: `cursor-canela-intro/src/app/api/webhooks/luma/route.ts`
- Modify: `cursor-canela-intro/env.example`

- [ ] **Step 1: Add import and entry log**

At top of `route.ts`, add:

```typescript
import { logLumaWebhookDebug } from "@/lib/debug/luma-webhook-log";
```

Immediately after resolving `eventId` and `projectId` (after line 56), add:

```typescript
  await logLumaWebhookDebug("handler_entry", {
    hypothesis: "H1",
    configuredEventId: eventId,
    projectId,
    webhookIdPresent: Boolean(request.headers.get("webhook-id")),
    syncProjectSource: process.env.SYNC_PROJECT_ID
      ? "SYNC_PROJECT_ID"
      : process.env.NEXT_PUBLIC_TEST_PROJECT_ID
        ? "NEXT_PUBLIC_TEST_PROJECT_ID"
        : process.env.TEST_PROJECT_ID
          ? "TEST_PROJECT_ID"
          : "none",
  });
```

- [ ] **Step 2: Add post-verification log**

After successful `verifyLumaWebhookSignature` (after line 72), add:

```typescript
  await logLumaWebhookDebug("signature_verified", {
    hypothesis: "entry",
    webhookIdPresent: Boolean(request.headers.get("webhook-id")),
  });
```

- [ ] **Step 3: Add duplicate-delivery log**

Inside the duplicate branch (before `return NextResponse.json` at line 78), add:

```typescript
      await logLumaWebhookDebug("duplicate_delivery", {
        hypothesis: "entry",
        webhookId: webhookId,
      });
```

Note: `webhookId` is an opaque delivery ID, not PII.

- [ ] **Step 4: Add ignore-branch logs**

Before each `recordDelivery` in ignore branches, add:

**Unhandled type (before line 94):**

```typescript
    await logLumaWebhookDebug("ignore_unhandled_type", {
      hypothesis: "H4",
      reason: "unhandled_type",
      payloadType: payload.type,
    });
```

**Event mismatch (before line 109):**

```typescript
    await logLumaWebhookDebug("ignore_event_mismatch", {
      hypothesis: "H2",
      reason: "event_mismatch",
      payloadEventId: payloadEventId ?? null,
      configuredEventId: eventId,
    });
```

**Not approved (before line 129):**

```typescript
    await logLumaWebhookDebug("ignore_not_approved", {
      hypothesis: "H3",
      reason: "not_approved",
      approvalStatus: payload.data.approval_status,
    });
```

- [ ] **Step 5: Add post-upsert log**

After `upsertAttendeeFromLumaGuest` (after line 154), add:

```typescript
  await logLumaWebhookDebug("upsert_complete", {
    hypothesis: result === "skipped" ? "H5" : "processed",
    result,
    projectId,
    lumaGuestId: payload.data.id,
  });
```

- [ ] **Step 6: Update env.example**

Add to `env.example`:

```
# Set to 1 to enable structured webhook debug logs (no PII)
LUMA_WEBHOOK_DEBUG=0

# Optional POST target for debug log ingest (local tooling)
# DEBUG_INGEST_URL=http://127.0.0.1:7242/ingest/your-session-id
```

- [ ] **Step 7: Manual smoke test**

Run dev server with debug enabled:

```bash
cd /home/marcelo/dev/private/cursor-canela-intro
LUMA_WEBHOOK_DEBUG=1 npm run dev
```

Send a test POST to `/api/webhooks/luma` (invalid signature is fine). Expected: console line `[luma-webhook-debug]` with `handler_entry` step before 401 response.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/webhooks/luma/route.ts env.example
git commit -m "feat: instrument Luma webhook with structured debug logs"
```

---

### Task 3: Shared env loader (canela-intro)

**Files:**
- Create: `cursor-canela-intro/scripts/lib/load-env.mjs`

- [ ] **Step 1: Create loader module**

```javascript
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadEnvFile(filename) {
  try {
    const content = readFileSync(resolve(process.cwd(), filename), "utf8");
    return Object.fromEntries(
      content
        .split("\n")
        .filter((line) => line && !line.startsWith("#"))
        .map((line) => {
          const idx = line.indexOf("=");
          if (idx === -1) return null;
          return [line.slice(0, idx).trim(), line.slice(idx + 1).trim()];
        })
        .filter(Boolean),
    );
  } catch {
    return {};
  }
}

export function loadMergedEnv() {
  return { ...loadEnvFile(".env"), ...loadEnvFile(".env.local"), ...process.env };
}
```

- [ ] **Step 2: Commit**

```bash
git add scripts/lib/load-env.mjs
git commit -m "chore: add shared env loader for scripts"
```

---

### Task 4: audit-env.mjs (canela-intro)

**Files:**
- Create: `cursor-canela-intro/scripts/audit-env.mjs`
- Modify: `cursor-canela-intro/package.json`

- [ ] **Step 1: Create audit script**

```javascript
#!/usr/bin/env node
import { loadMergedEnv } from "./lib/load-env.mjs";

const env = loadMergedEnv();

const syncProjectId = env.SYNC_PROJECT_ID;
const testProjectId = env.NEXT_PUBLIC_TEST_PROJECT_ID;
const fallbackTestId = env.TEST_PROJECT_ID;
const lumaEventId = env.LUMA_EVENT_ID;
const firebaseProjectId = env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
const webhookSecretSet = Boolean(env.LUMA_WEBHOOK_SECRET);

const resolvedProjectId =
  syncProjectId ?? testProjectId ?? fallbackTestId ?? null;

const drift =
  syncProjectId &&
  testProjectId &&
  syncProjectId !== testProjectId;

const warnings = [];

if (!syncProjectId) {
  warnings.push("SYNC_PROJECT_ID is unset — webhook falls back to NEXT_PUBLIC_TEST_PROJECT_ID or TEST_PROJECT_ID (H1 risk)");
}
if (drift) {
  warnings.push(
    `SYNC_PROJECT_ID (${syncProjectId}) differs from NEXT_PUBLIC_TEST_PROJECT_ID (${testProjectId})`,
  );
}
if (!lumaEventId) {
  warnings.push("LUMA_EVENT_ID is unset — all deliveries will 500 (H2 risk)");
}
if (resolvedProjectId === firebaseProjectId) {
  warnings.push(
    `Resolved project id equals Firebase project id (${firebaseProjectId}) — must be Firestore projects/ doc id, not Firebase project id`,
  );
}
if (!webhookSecretSet) {
  warnings.push("LUMA_WEBHOOK_SECRET is unset");
}

const report = {
  firebaseProjectId,
  syncProjectId: syncProjectId ?? null,
  nextPublicTestProjectId: testProjectId ?? null,
  testProjectId: fallbackTestId ?? null,
  resolvedProjectId,
  lumaEventId: lumaEventId ?? null,
  webhookSecretSet,
  drift: Boolean(drift),
  warnings,
};

console.log(JSON.stringify(report, null, 2));

if (warnings.length > 0) {
  process.exit(1);
}
```

- [ ] **Step 2: Add npm script**

In `package.json`:

```json
"audit:env": "node scripts/audit-env.mjs"
```

- [ ] **Step 3: Run audit**

```bash
cd /home/marcelo/dev/private/cursor-canela-intro
npm run audit:env
```

Expected: JSON report printed; exit 1 if warnings present (expected locally without prod env).

- [ ] **Step 4: Commit**

```bash
git add scripts/audit-env.mjs package.json
git commit -m "feat: add audit-env script for webhook configuration drift"
```

---

### Task 5: Firestore admin script foundation (credits-portal)

**Files:**
- Create: `cursor-credits-portal/scripts/lib/load-env.mjs`
- Create: `cursor-credits-portal/scripts/lib/firestore-admin.mjs`
- Modify: `cursor-credits-portal/package.json`

- [ ] **Step 1: Install firebase-admin**

```bash
cd /home/marcelo/dev/private/cursor-credits-portal
npm install --save-dev firebase-admin
```

- [ ] **Step 2: Create load-env.mjs**

Same content as canela-intro `scripts/lib/load-env.mjs` (copy file).

- [ ] **Step 3: Create firestore-admin.mjs**

```javascript
import admin from "firebase-admin";
import { loadMergedEnv } from "./load-env.mjs";

const EXPECTED_PROJECT_ID = "cursor-redeem-17668";

let app;

export function initFirestoreAdmin() {
  if (app) return admin.firestore();

  const env = loadMergedEnv();
  const projectId = env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? EXPECTED_PROJECT_ID;

  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error(
      "GOOGLE_APPLICATION_CREDENTIALS must point to a service account JSON file",
    );
    process.exit(1);
  }

  app = admin.apps.length
    ? admin.app()
    : admin.initializeApp({ projectId });

  return admin.firestore();
}

export function assertExpectedProject(projectId) {
  if (projectId !== EXPECTED_PROJECT_ID) {
    console.error(
      `Abort: Firebase project is "${projectId}", expected "${EXPECTED_PROJECT_ID}"`,
    );
    process.exit(1);
  }
}

export async function listAllCollections(db) {
  const collections = await db.listCollections();
  return collections.map((col) => col.id).sort();
}

export async function countCollection(db, name) {
  const snap = await db.collection(name).count().get();
  return snap.data().count;
}

export async function fetchAllDocs(db, name) {
  const snap = await db.collection(name).get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

export async function deleteCollectionBatched(db, name, batchSize = 500) {
  let deleted = 0;
  while (true) {
    const snap = await db.collection(name).limit(batchSize).get();
    if (snap.empty) break;

    const batch = db.batch();
    snap.docs.forEach((doc) => batch.delete(doc.ref));
    await batch.commit();
    deleted += snap.size;
  }
  return deleted;
}
```

- [ ] **Step 4: Commit**

```bash
git add scripts/lib/load-env.mjs scripts/lib/firestore-admin.mjs package.json package-lock.json
git commit -m "chore: add firebase-admin foundation for Firestore scripts"
```

---

### Task 6: Audit helpers with tests (credits-portal)

**Files:**
- Create: `cursor-credits-portal/scripts/lib/audit-helpers.mjs`
- Create: `cursor-credits-portal/scripts/lib/audit-helpers.test.mjs`
- Modify: `cursor-credits-portal/package.json`

- [ ] **Step 1: Write the failing test**

Create `scripts/lib/audit-helpers.test.mjs`:

```javascript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flagLegacyMarkers } from "./audit-helpers.mjs";

describe("flagLegacyMarkers", () => {
  it("flags @example.com emails", () => {
    const flags = flagLegacyMarkers("attendees", [
      { id: "a1", email: "test@example.com", projectId: "p1" },
    ]);
    assert.equal(flags.length, 1);
    assert.match(flags[0], /@example\.com/);
  });

  it("flags sample-event-1 projectId", () => {
    const flags = flagLegacyMarkers("attendees", [
      { id: "a2", projectId: "sample-event-1" },
    ]);
    assert.equal(flags.length, 1);
    assert.match(flags[0], /sample-event-1/);
  });

  it("returns empty for clean docs", () => {
    const flags = flagLegacyMarkers("codes", [
      { id: "c1", projectId: "real-project-id", code: "ABC" },
    ]);
    assert.deepEqual(flags, []);
  });
});
```

Add script:

```json
"test:audit-helpers": "node --test scripts/lib/audit-helpers.test.mjs"
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm run test:audit-helpers
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement audit-helpers.mjs**

```javascript
export function flagLegacyMarkers(collectionName, docs) {
  const flags = [];
  for (const doc of docs) {
    const email = doc.email ?? doc.attendeeEmail ?? "";
    if (typeof email === "string" && email.includes("@example.com")) {
      flags.push(`${collectionName}/${doc.id}: @example.com email`);
    }
    const projectId = doc.projectId ?? doc.eventId ?? "";
    if (projectId === "sample-event-1") {
      flags.push(`${collectionName}/${doc.id}: legacy sample-event-1`);
    }
    if (doc.slug === "sample-event-1") {
      flags.push(`${collectionName}/${doc.id}: legacy slug sample-event-1`);
    }
  }
  return flags;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm run test:audit-helpers
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/audit-helpers.mjs scripts/lib/audit-helpers.test.mjs package.json
git commit -m "feat: add audit helper functions for legacy Firestore markers"
```

---

### Task 7: audit-firestore.mjs (credits-portal)

**Files:**
- Create: `cursor-credits-portal/scripts/audit-firestore.mjs`
- Modify: `cursor-credits-portal/package.json`

- [ ] **Step 1: Create audit script**

```javascript
#!/usr/bin/env node
import { loadMergedEnv } from "./lib/load-env.mjs";
import {
  initFirestoreAdmin,
  assertExpectedProject,
  listAllCollections,
  countCollection,
  fetchAllDocs,
} from "./lib/firestore-admin.mjs";
import { flagLegacyMarkers } from "./lib/audit-helpers.mjs";

const KNOWN_COLLECTIONS = [
  "projects",
  "codes",
  "attendees",
  "redemptions",
  "webhook_deliveries",
];

const env = loadMergedEnv();
const projectId = env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
assertExpectedProject(projectId);

const db = initFirestoreAdmin();
const collections = await listAllCollections(db);
const unknown = collections.filter((c) => !KNOWN_COLLECTIONS.includes(c));

const counts = {};
for (const name of collections) {
  counts[name] = await countCollection(db, name);
}

const projects = await fetchAllDocs(db, "projects");
const legacyFlags = [];

for (const col of ["attendees", "codes", "redemptions"]) {
  if (!collections.includes(col)) continue;
  const docs = await fetchAllDocs(db, col);
  legacyFlags.push(...flagLegacyMarkers(col, docs.map((d) => ({ id: d.id, ...d }))));
}

const report = {
  firebaseProjectId: projectId,
  collections,
  unknownCollections: unknown,
  counts,
  projects: projects.map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    status: p.status,
  })),
  legacyFlags,
  totalDocuments: Object.values(counts).reduce((a, b) => a + b, 0),
};

console.log(JSON.stringify(report, null, 2));

if (unknown.length > 0) {
  console.error(`Warning: unknown collections found: ${unknown.join(", ")}`);
}
```

- [ ] **Step 2: Add npm script**

```json
"audit:firestore": "node scripts/audit-firestore.mjs"
```

- [ ] **Step 3: Run audit against production**

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/cursor-redeem-17668-sa.json
npm run audit:firestore
```

Expected: JSON with collection counts, project list, legacy flags. Non-zero exit only on credential/project mismatch.

- [ ] **Step 4: Commit**

```bash
git add scripts/audit-firestore.mjs package.json
git commit -m "feat: add Firestore audit script for pre-reset diagnostics"
```

---

### Task 8: export-firestore.mjs (credits-portal)

**Files:**
- Create: `cursor-credits-portal/scripts/export-firestore.mjs`
- Modify: `cursor-credits-portal/.gitignore`
- Modify: `cursor-credits-portal/package.json`

- [ ] **Step 1: Add backups/ to .gitignore**

```
backups/
```

- [ ] **Step 2: Create export script**

```javascript
#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadMergedEnv } from "./lib/load-env.mjs";
import {
  initFirestoreAdmin,
  assertExpectedProject,
  listAllCollections,
  fetchAllDocs,
} from "./lib/firestore-admin.mjs";

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

const env = loadMergedEnv();
const projectId = env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
assertExpectedProject(projectId);

const db = initFirestoreAdmin();
const collections = await listAllCollections(db);

const backup = {
  exportedAt: new Date().toISOString(),
  firebaseProjectId: projectId,
  collections: {},
};

for (const name of collections) {
  const docs = await fetchAllDocs(db, name);
  backup.collections[name] = docs;
}

const dir = join(process.cwd(), "backups");
await mkdir(dir, { recursive: true });
const filename = `${timestamp()}.json`;
const filepath = join(dir, filename);
await writeFile(filepath, JSON.stringify(backup, null, 2), "utf8");

console.log(JSON.stringify({ success: true, filepath, collections: collections.length }));
```

- [ ] **Step 3: Add npm script and run**

```json
"export:firestore": "node scripts/export-firestore.mjs"
```

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/cursor-redeem-17668-sa.json
npm run export:firestore
```

Expected: `backups/YYYY-MM-DD-HHMM.json` created; console prints filepath.

- [ ] **Step 4: Commit**

```bash
git add scripts/export-firestore.mjs .gitignore package.json
git commit -m "feat: add Firestore export backup script"
```

---

### Task 9: reset-firestore.mjs (credits-portal)

**Files:**
- Create: `cursor-credits-portal/scripts/reset-firestore.mjs`
- Modify: `cursor-credits-portal/package.json`

- [ ] **Step 1: Create reset script**

```javascript
#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { loadMergedEnv } from "./lib/load-env.mjs";
import {
  initFirestoreAdmin,
  assertExpectedProject,
  listAllCollections,
  countCollection,
  deleteCollectionBatched,
} from "./lib/firestore-admin.mjs";

const CONFIRM_FLAG = "--confirm";
const CONFIRM_VALUE = "PRODUCTION_RESET";

const args = process.argv.slice(2);
const confirmIdx = args.indexOf(CONFIRM_FLAG);
const confirmValue = confirmIdx >= 0 ? args[confirmIdx + 1] : null;

if (confirmValue !== CONFIRM_VALUE) {
  console.error(
    `Usage: node scripts/reset-firestore.mjs ${CONFIRM_FLAG} ${CONFIRM_VALUE}`,
  );
  process.exit(1);
}

const env = loadMergedEnv();
const projectId = env.NEXT_PUBLIC_FIREBASE_PROJECT_ID;
assertExpectedProject(projectId);

console.log(`Target Firebase project: ${projectId}`);
console.log("Running export backup before delete...");

const exportResult = spawnSync("node", ["scripts/export-firestore.mjs"], {
  stdio: "inherit",
  cwd: process.cwd(),
});

if (exportResult.status !== 0) {
  console.error("Export failed — aborting reset");
  process.exit(1);
}

const db = initFirestoreAdmin();
const collections = await listAllCollections(db);
const deletionCounts = {};

for (const name of collections) {
  const deleted = await deleteCollectionBatched(db, name);
  deletionCounts[name] = deleted;
  console.log(`Deleted ${deleted} docs from ${name}`);
}

const remaining = {};
for (const name of collections) {
  remaining[name] = await countCollection(db, name);
}

const allZero = Object.values(remaining).every((n) => n === 0);

console.log(JSON.stringify({ deletionCounts, remaining, allZero }, null, 2));

if (!allZero) {
  console.error("Reset incomplete — some collections still have documents");
  process.exit(1);
}

console.log("Firestore reset complete");
```

- [ ] **Step 2: Add npm script**

```json
"reset:firestore": "node scripts/reset-firestore.mjs"
```

- [ ] **Step 3: Dry-run gate check (do NOT run full reset yet)**

Verify script refuses without confirm flag:

```bash
node scripts/reset-firestore.mjs
```

Expected: exit 1 with usage message.

Full reset is executed only in Phase 4 runbook after webhook fix is confirmed.

- [ ] **Step 4: Commit**

```bash
git add scripts/reset-firestore.mjs package.json
git commit -m "feat: add gated Firestore reset script with auto-export"
```

---

## Phase 2 — Fix activation (manual runbook)

Execute after Phase 1 diagnostics. No code changes unless logs reveal a bug beyond env misconfiguration.

- [ ] **Step 1: Run canela-intro env audit on Vercel-resolved values**

Locally mirror production `.env.local` or run `npm run audit:env` after pulling Vercel env via dashboard. Record `resolvedProjectId` and `lumaEventId`.

- [ ] **Step 2: Run credits-portal Firestore audit**

```bash
cd /home/marcelo/dev/private/cursor-credits-portal
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json
npm run audit:firestore
```

Copy the Firestore `projects/{docId}` for the production event from the `projects` array.

- [ ] **Step 3: Compare IDs (H1 check)**

`SYNC_PROJECT_ID` (canela-intro) **must equal** the credits-portal project doc ID. If not, update Vercel env:

- `SYNC_PROJECT_ID={docId}`
- `LUMA_EVENT_ID=evt-...` (exact match from Luma dashboard)

- [ ] **Step 4: Redeploy canela-intro**

Redeploy after env changes. Set `LUMA_WEBHOOK_DEBUG=1` temporarily on Vercel.

- [ ] **Step 5: Luma manual checklist**

1. Webhook URL: `https://<canela-intro-host>/api/webhooks/luma`
2. Event types: `guest.registered`, `guest.updated`
3. Send test delivery from Luma dashboard
4. Note HTTP status + response body
5. Inspect latest `webhook_deliveries` doc: `outcome` and `reason`

- [ ] **Step 6: Confirm processed before reset**

Re-test until response is `{ result: "created" }` and `webhook_deliveries` shows `outcome: "processed"` with correct `projectId`. **Do not proceed to Phase 4 until this passes.**

---

## Phase 3 — Export backup (manual)

- [ ] **Step 1: Run export**

```bash
npm run export:firestore
```

Expected: `backups/YYYY-MM-DD-HHMM.json` with all collections.

- [ ] **Step 2: Verify backup file size**

```bash
ls -lh backups/
```

Expected: non-empty JSON file. Open and confirm `collections.projects`, `collections.attendees` keys exist.

---

## Phase 4 — Full Firestore reset (manual, destructive)

**Precondition:** Phase 2 webhook test passes with `outcome: "processed"`.

- [ ] **Step 1: Run reset**

```bash
npm run reset:firestore -- --confirm PRODUCTION_RESET
```

Expected: auto-export, per-collection deletion counts, `allZero: true`.

- [ ] **Step 2: Verify with audit**

```bash
npm run audit:firestore
```

Expected: all collection counts `0`; `projects` array empty.

---

## Phase 5 — Post-reset bootstrap (manual)

| Step | Action |
|------|--------|
| 1 | Create event project at credits-portal `/admin/projects` |
| 2 | Copy Firestore doc ID from creation response |
| 3 | Set `SYNC_PROJECT_ID={docId}` in canela-intro Vercel |
| 4 | Set `LUMA_EVENT_ID=evt-...` in canela-intro Vercel |
| 5 | Redeploy canela-intro |
| 6 | Upload codes CSV at credits-portal `/admin/uploads` (select new project) |
| 7 | Trigger Luma test webhook for an approved guest |
| 8 | Verify attendee in `/admin/attendees` and complete redeem at `/{slug}` |

- [ ] **Step 1–8:** Execute bootstrap checklist above.

---

## Phase 6 — E2E verification (manual)

| Test | Expected | Pass? |
|------|----------|-------|
| Luma test webhook | HTTP 200, `{ result: "created" }` | |
| `webhook_deliveries/{id}` | `outcome: "processed"`, `projectId` matches admin project | |
| Admin attendees page | Guest visible under correct project | |
| Redeem flow | Code assigned; `redemptions` doc created | |
| Debug logs | H1–H5 confirmed or rejected with cited log lines | |

- [ ] **Step 1: Run E2E table above and record results.**

- [ ] **Step 2: Remove debug instrumentation (only after user confirms E2E pass)**

In canela-intro:
1. Remove `logLumaWebhookDebug` calls from `route.ts`
2. Set `LUMA_WEBHOOK_DEBUG=0` on Vercel (or remove var)
3. Optionally keep `src/lib/debug/luma-webhook-log.ts` for future use

```bash
git commit -m "chore: remove temporary Luma webhook debug instrumentation"
```

---

## Self-Review Checklist

### Spec coverage

| Spec requirement | Task |
|------------------|------|
| Webhook debug logs at entry, verify, duplicate, ignore branches, upsert | Task 2 |
| No PII in logs | Task 1 `sanitizeWebhookDebugPayload` |
| `audit-env.mjs` with SYNC vs TEST drift | Task 4 |
| `audit-firestore.mjs` projects, counts, legacy flags | Task 7 |
| `export-firestore.mjs` → `backups/YYYY-MM-DD-HHMM.json` | Task 8 |
| `reset-firestore.mjs` with `--confirm PRODUCTION_RESET` | Task 9 |
| Project ID guard `cursor-redeem-17668` | Task 5 `assertExpectedProject` |
| Auto-export before reset | Task 9 spawn export |
| Paginated batch delete (500) | Task 5 `deleteCollectionBatched` |
| Verify zero counts post-reset | Task 9 |
| Phase 2/5/6 manual runbooks | Phases 2–6 sections |
| Remove debug after E2E | Phase 6 Step 2 |

### Placeholder scan

No TBD/TODO placeholders. All code blocks are complete.

### Type consistency

- `logLumaWebhookDebug(step, payload)` used consistently
- `flagLegacyMarkers(collectionName, docs)` returns string array
- `CONFIRM_VALUE` is `"PRODUCTION_RESET"` everywhere

---

## Risks & Notes

1. **Service account required:** Credits-portal scripts need `GOOGLE_APPLICATION_CREDENTIALS`. Client SDK public config is insufficient for `listCollections()`.
2. **Vercel file writes:** NDJSON logs only persist locally; production diagnosis relies on `console.info` in Vercel function logs when `LUMA_WEBHOOK_DEBUG=1`.
3. **Cross-repo commits:** Tasks alternate repos; commit in each repo separately.
4. **Do not reset before webhook fix:** Phase 4 is blocked until Phase 2 shows `outcome: "processed"`.
