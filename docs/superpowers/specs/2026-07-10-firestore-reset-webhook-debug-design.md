# Firestore Reset & Webhook Debug Design

**Date:** 2026-07-10  
**Status:** Approved (design review)  
**Repos:** `cursor-credits-portal`, `cursor-canela-intro`  
**Firebase project:** `cursor-redeem-17668`

## Problem

Production rollout is blocked by:

1. **Webhook returns HTTP 200 but attendees never appear** in the credits-portal admin/redeem flow.
2. **Polluted Firestore** containing seed data, legacy `sample-event-1` documents, and `@example.com` test records.

Both apps share one Firestore database. The Luma webhook lives in `cursor-canela-intro`; admin and redemption live in `cursor-credits-portal`.

## Decisions

| Topic | Decision |
|-------|----------|
| Webhook symptom | HTTP 200, no attendee data in expected project |
| Production target | Project created via credits-portal `/admin/projects` |
| Webhook home | Remain in `cursor-canela-intro` |
| Reset scope | Full wipe of all collections |
| Test environment | Production only (`cursor-redeem-17668`) |
| Luma access | Full dashboard (delivery logs, test events) |

## Architecture

```
Luma ──POST──> cursor-canela-intro /api/webhooks/luma
                      │
                      ├──> webhook_deliveries (idempotency + audit)
                      └──> attendees (projectId = SYNC_PROJECT_ID)

cursor-credits-portal /admin/projects ──> projects/{docId}
cursor-credits-portal /admin/uploads    ──> codes, attendees
cursor-credits-portal /{slug} redeem     ──> attendees (by project slug → docId)
```

### Cross-repo contract

1. Admin creates `projects/{docId}` in credits-portal.
2. `SYNC_PROJECT_ID` in canela-intro Vercel env **must equal** `{docId}`.
3. `LUMA_EVENT_ID` must exactly match the Luma event ID in webhook payloads.
4. Luma webhook URL: `https://<canela-intro-host>/api/webhooks/luma`.
5. Luma event types: `guest.registered` and `guest.updated` at minimum.

`SYNC_PROJECT_ID` is env-driven only; it is never read from the webhook payload. A mismatch writes attendees to a project the redeem UI never queries.

## Phase 1: Pre-reset diagnostics

### Hypotheses

| ID | Hypothesis | Failure mode in webhook route |
|----|------------|-------------------------------|
| H1 | `SYNC_PROJECT_ID` wrong or missing | Writes to orphan `projectId` |
| H2 | `LUMA_EVENT_ID` mismatch | `event_mismatch` → ignored, HTTP 200 |
| H3 | Guest not `approved` | `not_approved` → ignored, HTTP 200 |
| H4 | Unhandled event type | `unhandled_type` → ignored, HTTP 200 |
| H5 | Upsert skipped (no email/name) | `result: "skipped"` in response |

### Instrumentation (`cursor-canela-intro`)

Add folded debug logs to `src/app/api/webhooks/luma/route.ts` at:

- Handler entry: resolved `eventId`, `projectId`, `webhook-id` presence (no secrets)
- Post signature verification
- Duplicate delivery check
- Each ignore branch: `reason`, `payloadEventId`, `configuredEventId`
- Post upsert: `result`, `projectId`

Logs use the debug ingest endpoint and NDJSON file. No PII (emails, names) in log payloads.

### Diagnostic scripts

| Script | Repo | Purpose |
|--------|------|---------|
| `scripts/audit-env.mjs` | canela-intro | Resolved env vars; flag `SYNC_PROJECT_ID` vs `NEXT_PUBLIC_TEST_PROJECT_ID` drift |
| `scripts/audit-firestore.mjs` | credits-portal | List projects, per-collection counts, flag legacy/test data |
| `scripts/export-firestore.mjs` | credits-portal | JSON backup before wipe |

### Manual Luma checklist

1. Confirm webhook URL points to canela-intro deployment.
2. Confirm event types include `guest.registered` + `guest.updated`.
3. Send test delivery; note HTTP status and response body.
4. Inspect latest `webhook_deliveries` doc for `outcome` and `reason`.

## Phase 2: Fix activation

Based on diagnostic evidence, apply the minimal fix. Most likely:

- Set `SYNC_PROJECT_ID` to the credits-portal project Firestore doc ID.
- Set `LUMA_EVENT_ID` to the exact Luma event ID.
- Redeploy canela-intro.

Re-run Luma test webhook and confirm `webhook_deliveries` shows `outcome: "processed"` with correct `projectId` before proceeding to reset.

## Phase 3: Export backup

Run `export-firestore.mjs` to write `backups/YYYY-MM-DD-HHMM.json` containing all collections. Reset script refuses to run if backup fails.

## Phase 4: Full Firestore reset

### Collections

Delete all documents in: `projects`, `codes`, `attendees`, `redemptions`, `webhook_deliveries`, and any additional top-level collections found by audit.

### Script: `cursor-credits-portal/scripts/reset-firestore.mjs`

1. Require `--confirm PRODUCTION_RESET` flag.
2. Print Firebase project ID from env; abort if mismatch with expected `cursor-redeem-17668`.
3. Auto-run export backup.
4. Paginated batch delete (500 docs per batch).
5. Print per-collection deletion counts.
6. Verify all collection counts are zero.

### Out of scope

- Firebase project deletion
- Vercel project changes (except env var values)
- Luma webhook re-registration (URL unchanged; only env values update)

## Phase 5: Post-reset bootstrap

| Step | Action |
|------|--------|
| 1 | Create event project in credits-portal `/admin/projects` |
| 2 | Copy Firestore doc ID |
| 3 | Set `SYNC_PROJECT_ID={docId}` in canela-intro Vercel |
| 4 | Set `LUMA_EVENT_ID=evt-...` in canela-intro Vercel |
| 5 | Redeploy canela-intro |
| 6 | Upload codes CSV via credits-portal `/admin/uploads` |
| 7 | Trigger Luma test webhook for an approved guest |
| 8 | Verify attendee in admin and complete redeem flow |

## Phase 6: E2E verification

| Test | Expected |
|------|----------|
| Luma test webhook | HTTP 200, `{ result: "created" }` |
| `webhook_deliveries/{id}` | `outcome: "processed"`, `projectId` matches admin project |
| Admin attendees page | Guest visible under correct project |
| Redeem flow | Code assigned; `redemptions` doc created |
| Debug logs | Hypotheses H1–H5 confirmed or rejected with cited log lines |

Remove debug instrumentation only after user confirms E2E pass.

## Deliverables

1. Instrumented webhook route (canela-intro)
2. `audit-env.mjs` (canela-intro)
3. `audit-firestore.mjs`, `export-firestore.mjs`, `reset-firestore.mjs` (credits-portal)
4. This spec document
5. Implementation plan (separate, via writing-plans skill)

## Deferred (not in this phase)

- Vitest / Playwright test framework
- Firebase Emulator setup
- Porting webhook into credits-portal
- Tightening Firestore security rules
- Removing `sample-event-1` legacy fallbacks in credits-portal code

## Risks

| Risk | Mitigation |
|------|------------|
| Prod-only testing | Export backup before any delete; confirm fix before wipe |
| Silent webhook ignores | Structured logs + `webhook_deliveries` audit |
| Env drift after reset | Bootstrap checklist with explicit doc ID copy step |
| Accidental wipe | `--confirm PRODUCTION_RESET` gate + project ID print |
