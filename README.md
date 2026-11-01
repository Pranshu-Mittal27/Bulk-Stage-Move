# bulk-stage-service

An ESM-first NestJS and PostgreSQL service with workspace-scoped opportunity APIs, durable bulk-job submission, lease-management primitives, and a callable bounded bulk-job processing operation. A polling/scheduling loop, standalone worker executable, automatic continuous batch execution, authentication, and UI are not included.

## Requirements

- Node.js 22.12 or newer (tested with Node.js 22.23.4)
- npm 10 or newer
- PostgreSQL (the local database is named `ghl_bulk_stage`)

## Setup

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Set `DATABASE_URL` in the local `.env` file to your PostgreSQL connection string. If `.env` does not exist, create it from the example:

   ```powershell
   Copy-Item .env.example .env -ErrorAction Stop
   ```

   Replace the example username, password, host, and port with your actual connection details. The database name is `ghl_bulk_stage`. URL-encode special characters in the username or password. Do not paste credentials into chat or commit `.env`.

3. Generate the Prisma client:

   ```powershell
   npm run db:generate
   ```

4. Verify the connection with a read-only query:

   ```powershell
   npm run db:check
   ```

The check executes `SELECT 1`, reports configuration errors separately from connection failures, and closes the Prisma client. It does not apply migrations or change database contents.

## Core data model

The schema defines workspaces, workspace-owned stages, opportunities, append-only-at-the-application-level opportunity transition history, and durable bulk-job submission state. A bulk job stores its workspace-scoped idempotency key, canonical request, target stage, lifecycle/health state, progress counts, and lease/retry metadata. Its item rows snapshot each opportunity's expected stage and version and retain per-item outcomes. Composite foreign keys enforce workspace consistency across jobs, stages, opportunities, transitions, and snapshot items. Stage positions are unique within each workspace; opportunity values must be non-negative and stage versions positive. Job counts, lease generations, retry counts, item attempts, and snapshot stage versions are constrained in the database.

The bulk-job schema is applied locally. Submission, status, lease management, and one-call bounded item processing are documented below. `BulkJobProcessingService.processBatch(token)` applies snapshot-safe stage moves, records item outcomes, and updates progress atomically for one bounded batch; it is callable but does not run automatically. A polling/scheduling loop, standalone worker executable, and automatic continuous batch execution remain out of scope. Review any forward-only migration SQL before applying it, and only migrate a database confirmed to be a development target.

Review the generated SQL in `prisma/migrations` before applying schema changes. To apply pending migrations to a confirmed development database, run:

```powershell
npm run db:migrate:dev
```

For a deployment environment, use the reviewed migrations with `npm run db:migrate:deploy`. These commands change the database schema; do not run them against a database until its target and contents are confirmed.

## Development

```powershell
npm run start:dev
```

The starter endpoint is `GET /`. Swagger UI is available at `http://localhost:3000/docs`.

## Quality checks

```powershell
npm run build
npm run lint
npm run format:check
npm test
npm run test:e2e
```

## Database scripts

```powershell
npm run db:validate
npm run db:generate
npm run db:check
npm run db:migrate:dev
npm run db:migrate:deploy
npm run db:studio
```

The `db:check` command executes a read-only connectivity probe. `db:check`, migration, and Studio commands require a configured `DATABASE_URL`. Review schema changes before applying any migrations.

## Opportunity API

All routes are under `/api/v1` and require `X-Workspace-Id` containing an existing workspace UUID. This header scopes tenant data; it is not authentication. Responses use JSON, return monetary values as fixed-precision decimal strings, and errors use `{ "statusCode", "code", "message", "path", "timestamp" }`.

### Create an opportunity

`POST /api/v1/opportunities`

```json
{
  "stageId": "54d73e72-03bc-4c20-859e-ad4996223cc6",
  "ownerId": null,
  "name": "Example opportunity",
  "value": "12500.00",
  "status": "open"
}
```

`ownerId` is optional or null; `status` defaults to `open`. The name is trimmed and must not be empty. `value` must be a non-negative decimal string with at most 15 integer and 4 fractional digits. Creation returns `201` with the opportunity and creates its initial manual transition atomically.

Example response:

```json
{
  "id": "d4d74d8d-f924-4ce2-a67f-60a913a4d1aa",
  "workspaceId": "c0f15139-f93f-4c8f-a03f-d56b67bef6c0",
  "stageId": "54d73e72-03bc-4c20-859e-ad4996223cc6",
  "ownerId": null,
  "name": "Example opportunity",
  "value": "12500.0000",
  "status": "open",
  "stageVersion": 1,
  "createdAt": "2026-11-01T00:00:00.000Z",
  "updatedAt": "2026-11-01T00:00:00.000Z"
}
```

### List opportunities in a stage

`GET /api/v1/opportunities?stageId=<uuid>&limit=50&cursor=<opaque-cursor>`

`stageId` is required; `limit` defaults to 50 and must be 1–100. The response is ordered by opportunity ID and has this shape:

```json
{
  "items": [],
  "pagination": {
    "limit": 50,
    "nextCursor": null
  }
}
```

Follow `nextCursor` as the `cursor` query parameter until it is null.

### Change stage

`PATCH /api/v1/opportunities/<opportunity-id>/stage`

```json
{
  "targetStageId": "e3f7aa35-a5dc-4a2d-baf7-839c817a0cd4",
  "expectedStageVersion": 1
}
```

The update is conditional on workspace, opportunity, current stage, and expected stage version. A successful move increments the version once and records one manual transition atomically. Repeating the current stage with the current version is a no-op. A stale version returns `409` with code `stage_version_conflict`; missing workspace-scoped resources return `404` with code `resource_not_found`. Invalid headers, IDs, query parameters, or bodies return `400` with code `validation_error`.

The `200` response has the same opportunity resource shape shown above, with the destination `stageId` and incremented `stageVersion`.

## Bulk stage move submission and status

These endpoints require `X-Workspace-Id` with an existing workspace UUID. Submission also requires an `Idempotency-Key`: it is trimmed, must contain 1–128 characters, and is unique within that workspace. This header is not authentication.

### Submit a bulk stage move

`POST /api/v1/bulk-stage-moves`

```http
X-Workspace-Id: c0f15139-f93f-4c8f-a03f-d56b67bef6c0
Idempotency-Key: quarterly-stage-change-2026-01
Content-Type: application/json
```

```json
{
  "targetStageId": "e3f7aa35-a5dc-4a2d-baf7-839c817a0cd4",
  "filter": {
    "stageId": "54d73e72-03bc-4c20-859e-ad4996223cc6",
    "ownerId": "c1e79796-a640-4a02-a47b-6e5043d9816f",
    "status": "open",
    "valueRange": { "min": "100.00", "max": "5000.00" },
    "createdAt": {
      "from": "2026-01-01T00:00:00.000Z",
      "to": "2026-02-01T00:00:00.000Z"
    }
  }
}
```

The filter and each member are optional. Supplied predicates combine with AND. Monetary bounds are inclusive decimal strings (no exponent notation); `createdAt.from` is inclusive and `createdAt.to` is exclusive. Decimal bounds are canonicalized to four fractional digits; ISO-8601 timestamps (up to nanosecond input precision) are normalized to UTC at PostgreSQL's microsecond precision; UUIDs are lowercased; omitted filter members normalize to `null` in the canonical request. The SHA-256 canonical request includes API version, workspace, target stage, and normalized filters.

The service counts and snapshots matching opportunity IDs, current stages, and stage versions in one PostgreSQL `REPEATABLE READ` transaction using set-based `INSERT ... SELECT`. Transaction acquisition waits at most 10 seconds, and a transaction is bounded to 60 seconds; the job is not visible until the complete snapshot commits. The maximum is 50,000 matching opportunities; larger requests return `422 validation_failed` without creating a job. Opportunities already at the target stage are included. Zero matches produce a completed job with zero counts and no items. No worker runs automatically in this milestone.

The first accepted request returns `202`; a repeated workspace/key with the same canonical request returns `200` and the existing job. Reusing the key for a different request returns `409 idempotency_key_reused`. A workspace-scoped unique constraint handles concurrent requests; the losing request compares the stored canonical request after the conflict.

### Get bulk job status

`GET /api/v1/bulk-stage-moves/<job-id>`

The lookup is scoped by both workspace and job. Missing and cross-workspace jobs return `404 resource_not_found`. The response contains persisted job state, with `pendingCount = matchedCount - processedCount`; failure messages are returned as a safe generic message rather than exposing internal details. `waitingReason` is currently null because there is no worker/wait-state implementation.

Example response:

```json
{
  "id": "8eecb639-dda9-4ad3-b1f6-f91b39db45a0",
  "status": "queued",
  "health": "healthy",
  "targetStageId": "e3f7aa35-a5dc-4a2d-baf7-839c817a0cd4",
  "matchedCount": 2,
  "processedCount": 0,
  "movedCount": 0,
  "skippedCount": 0,
  "failedCount": 0,
  "pendingCount": 2,
  "createdAt": "2026-11-01T00:00:00.000Z",
  "startedAt": null,
  "completedAt": null,
  "heartbeatAt": null,
  "lastProgressAt": null,
  "failureCode": null,
  "failureMessage": null,
  "waitingReason": null
}
```

Invalid headers, keys, UUIDs, filter values, ranges, and timestamps return `400 validation_error`. A destination stage outside the workspace returns `404 resource_not_found`.

### Lease-management service

The internal `BulkJobLeaseService` provides `claimNext(workerId)` and `renew(token)` for a future worker process. Claims atomically select one due queued job or one running job with an expired lease using PostgreSQL row locking and database time. A successful claim sets status to `running`, assigns the owner and expiry, updates the heartbeat, and increments `leaseGeneration`; `startedAt` is set only once. Renewal succeeds only while the matching job ID, owner, generation, running status, and unexpired lease still match. A stale token returns `{ "kind": "lease_lost" }`; no eligible job returns `{ "kind": "empty" }`.

The caller supplies a stable worker ID; the service does not generate one. `BULK_JOB_LEASE_DURATION_MS` configures lease duration, defaulting to 30,000 milliseconds and accepting values from 1,000 through 300,000 milliseconds. Claims and renewals use PostgreSQL time.

`BulkJobProcessingService.processBatch(token)` performs one bounded batch for a supplied lease token. `BULK_JOB_BATCH_SIZE` defaults to 100 and accepts values from 1 through 500. The method locks the job row before validating the owner, generation, running status, and database-time lease expiry, and keeps that lock through the batch transaction. It selects due pending items by `itemId`; it does not use or advance `cursorItemId`, so ID gaps and pending retries behind a cursor remain visible. Successful moves, stale-snapshot/already-at-destination skips, transitions, item outcomes, and progress counters commit atomically. Jobs become terminal only when every matched item has a terminal outcome. A stale token returns `{ "kind": "lease_lost" }`, and a job without due pending items returns `{ "kind": "no_due_pending_items" }`.

The method does not poll or schedule work. Unexpected processing/database errors are surfaced and roll back the entire batch, leaving selected items pending and progress unchanged; no item is permanently failed by this operation. Recognized Prisma transaction conflicts and PostgreSQL serialization/deadlock errors also record the affected pending item's attempt count and error code in a separate lease-fenced transaction after rollback. That item remains pending but is deferred by `BULK_JOB_RETRY_BACKOFF_MS`, default 30,000 milliseconds, configurable from 1,000 through 3,600,000 milliseconds. This finite fixed delay prevents immediate re-selection while allowing later items to progress; callers remain responsible for invoking future batches. A `RetryableBulkJobProcessingError` exposes the affected item ID, original error as `cause`, and whether retry metadata was recorded, skipped because the lease/item was no longer eligible, or failed. The lease token fences batch processing only; any later work outside this transaction must independently validate ownership in its business transaction.

### API tests

The end-to-end suite uses unique workspace fixtures in the configured PostgreSQL database and removes only those fixtures afterward. It does not reset the database. Configure `DATABASE_URL` and apply the reviewed migrations before running:

```powershell
npm run db:migrate:deploy
npm test
npm run test:e2e
```
