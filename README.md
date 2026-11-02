# bulk-stage-service

An ESM-first NestJS and PostgreSQL service with workspace-scoped opportunity APIs, durable bulk-job submission, lease management, bounded batch processing, and a separately runnable worker execution loop with deferred-job scheduling. Authentication and UI are not included.

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

The bulk-job schema is applied locally. Submission, status, lease management, bounded item processing, and the worker execution loop are documented below. `BulkJobProcessingService.processBatch(token)` applies snapshot-safe stage moves, records item outcomes, and updates progress atomically for one bounded batch. The separately run worker claims jobs, processes batches sequentially, renews leases, defers jobs whose pending items are all scheduled for the future, and handles shutdown; it does not start automatically with the API. Review any forward-only migration SQL before applying it, and only migrate a database confirmed to be a development target.

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

## Worker

The API and worker run as separate processes and share the same PostgreSQL database and durable job queue. Start the API with `npm run start:dev`; in a second terminal, start the worker with `npm run start:worker:dev`. After building, run the worker with `npm run start:worker`. The worker creates a NestJS application context without an HTTP listener.

Each worker process handles one claimed job at a time and yields after at most five completed batch or recorded retry attempts when work remains. Empty polls while due rows are locked do not consume the quantum. The yield transaction checks the current lease owner, generation, and expiry; it then returns due work to `queued` and releases the lease. The next claim increments the lease generation, so the yielding worker cannot continue with its old token. Eligible jobs are ordered by oldest progress time (falling back to creation time), so a recently progressed job moves behind jobs that have waited longer. This is a basic job-scheduling fairness measure, not workspace isolation or a starvation guarantee. Multiple worker processes may run concurrently; PostgreSQL row locking and lease generations coordinate claims.

A claim requires at least one pending item whose item-level `nextAttemptAt` is null or due according to PostgreSQL time. Item scheduling is authoritative: the job-level `nextAttemptAt` is only a scheduling hint, so stale hints cannot make future-only work run early or hide due items. At a yield boundary, if all remaining items are scheduled in the future, the worker returns the job to `queued` at the earliest pending-item time without changing item schedules, then releases the lease. A later claim increments the lease generation and clears the hint.

If a batch reports no due items but the deferral check finds due items still present, the worker waits with bounded polling jitter and renews the lease only when needed before checking again. If the deferral transaction errors, its commit outcome may be ambiguous: the worker discards the token, stops that attempt, waits with bounded backoff, and returns to normal claim polling without processing or renewing with the old token. A no-pending-items result is treated as an anomaly, not as successful completion. The worker also runs a read-only diagnostic at most once per minute, logging IDs and statuses of queued/running jobs with no pending items and logging diagnostic query errors.

Yielding improves the opportunity for other eligible jobs to run, but does not guarantee interactive API latency: worker and API processes still share PostgreSQL resources. Due items that remain locked may keep a worker polling and renewing their job lease, and zero-pending anomalies are logged but not automatically reconciled or completed. SIGINT/SIGTERM stop new claims and allow an active batch to settle before the process closes its database connection. Any unfinished lease is left for normal expiry and reclaim; the worker does not forcibly release it.

`BULK_JOB_WORKER_LEASE_DURATION_MS` defaults to 120,000 milliseconds and must be at least 90,000 milliseconds for the worker. It is worker-specific; the API's existing `BULK_JOB_LEASE_DURATION_MS` setting and 30,000-millisecond default are unchanged. `BULK_JOB_POLL_INTERVAL_MS` defaults to 1,000 milliseconds and accepts values from 100 through 60,000 milliseconds. `BULK_JOB_WORKER_ID` is optional; when omitted, the worker uses its hostname and process ID. Poll waits include up to 20% jitter. Claim-error backoff doubles from the configured poll interval, caps its base delay at 30 seconds, then applies the same jitter, so its maximum actual wait is less than 36 seconds.

## Quality checks

```powershell
npm run build
npm run lint
npm run format:check
npm test
```

**E2E database safety:** E2E tests use the effective `DATABASE_URL`; they write and delete fixtures and may create and drop test triggers. Use a separate, dedicated disposable PostgreSQL database. Never run E2E tests against the seed, benchmark, development, or any valuable database. Set `DATABASE_URL` to that test database in the same PowerShell session where you run the tests. A database name alone does not establish that the server or database is disposable; independently verify the target server and database in pgAdmin first. Do not expose or print connection strings.

To prepare and run E2E tests, first create or select the dedicated disposable test database and independently verify its server and database identity in pgAdmin. Then, in the PowerShell terminal used for the tests, configure the test database URL (replace placeholders locally; URL-encode special characters):

```powershell
$env:DATABASE_URL = 'postgresql://<URL-encoded-user>:<URL-encoded-password>@<verified-test-server>:<port>/ghl_bulk_stage_test'
node -e "console.log(decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1)))"
npm run db:generate
npm run db:migrate:deploy
npm run test:e2e -- --runInBand
```

The name-only check should report `ghl_bulk_stage_test`; it does not verify server identity or prove disposability. Run `db:migrate:deploy` only after independently confirming the selected target is the dedicated disposable test database, and only when its schema migrations have not already been applied. Keep this same terminal and `DATABASE_URL` for the E2E command. Do not use the seed or benchmark database for this sequence.

## Database scripts

For the assignment dataset, use a dedicated, disposable PostgreSQL database. The existing seed database is named `ghl_bulk_stage_seed`; use a separate database such as `ghl_bulk_stage_bench` for an isolated benchmark run. Choose one target throughout the steps below. Create it only if it does not already exist:

1. If the selected database does not already exist, create it using pgAdmin or a PostgreSQL administration connection. Run only the matching statement:

   ```sql
   CREATE DATABASE ghl_bulk_stage_seed;
   ```

   Or, instead:

   ```sql
   CREATE DATABASE ghl_bulk_stage_bench;
   ```

2. In the PowerShell terminal you will use for the remaining commands, set `DATABASE_URL` to the selected database. Replace the placeholders locally; URL-encode special characters in the username or password. Use the URL for the same database you selected in step 1:

   ```powershell
   $env:DATABASE_URL = 'postgresql://<URL-encoded-user>:<URL-encoded-password>@<host>:<port>/ghl_bulk_stage_seed'
   node -e "console.log(decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1)))"
   ```

   Or, for the isolated benchmark database:

   ```powershell
   $env:DATABASE_URL = 'postgresql://<URL-encoded-user>:<URL-encoded-password>@<host>:<port>/ghl_bulk_stage_bench'
   node -e "console.log(decodeURIComponent(new URL(process.env.DATABASE_URL).pathname.slice(1)))"
   ```

   The second command prints only the URL's database name, not credentials. Independently verify both server and database in pgAdmin before proceeding, for example with `SELECT current_database(), current_user, inet_server_addr(), inet_server_port();`. The seed confirmation and database-name checks do not verify server identity or prove the database is disposable.

3. Generate the Prisma client if needed:

   ```powershell
   npm run db:generate
   ```

4. Apply the existing migrations to the verified target:

   ```powershell
   npm run db:migrate:deploy
   ```

5. Run the assignment seed with an explicit confirmation matching the selected database name. The existing seed command remains:

   ```powershell
   npm run db:seed:assignment -- --confirm-disposable-database ghl_bulk_stage_seed
   ```

   For the separate benchmark database configured above, use:

   ```powershell
   npm run db:seed:assignment -- --confirm-disposable-database ghl_bulk_stage_bench
   ```

   Names must start with a lowercase letter, contain only lowercase letters, digits, or underscores, and be no longer than 63 characters. The script checks that the decoded `DATABASE_URL` database name and PostgreSQL `current_database()` both match the explicit confirmation. These name checks do not validate host/server identity or prove disposability; independently verify the server and database before migrating or seeding.

6. Run validation checks:

   ```powershell
   npm run db:validate
   npm run db:check
   npm test -- --runInBand scripts/assignment-seed-data.spec.ts
   npm run format:check
   npm run lint
   npm test
   ```

   Run E2E tests separately using the dedicated disposable test-database procedure above, not the seed or benchmark database configured for this section.

Both `db:migrate:deploy` and `db:seed:assignment` write to the database selected by `DATABASE_URL`. Independently verify the PostgreSQL server **and** database before running either command; never run them against a production, shared, or otherwise valuable database. The seed uses bounded inserts and is not one transaction, so an interruption can leave partial data. It does not delete or update existing records.

The `db:check` command executes a read-only connectivity probe. Database, migration, and Studio commands require a configured `DATABASE_URL`. Review schema changes before applying any migrations.

### Assignment dataset seed

The assignment seed creates six workspaces, each with 12 stages. The large workspace has exactly 500,000 opportunities distributed unevenly across its stages; the five smaller workspaces have 2,000, 2,500, 3,000, 3,500, and 4,000 opportunities. Opportunity dates are deterministically spread from May 1, 2025 through November 1, 2026 (UTC).

The seed uses fixed IDs and bounded 1,000-row inserts with duplicate skipping, which supports resuming an interrupted run. It does not delete or update existing records. On reruns it verifies workspace totals, stage counts, and date bounds, but does not validate each existing opportunity's fields individually; aggregate checks can miss modified fields. Workspace and stage creation timestamps use database defaults and are not fully deterministic, and writes from earlier batches remain if the script fails. Existing seed workspace/stage conflicts or an opportunity count above the expected total cause it to stop rather than clean up records.

The generated dataset plan is covered by `scripts/assignment-seed-data.spec.ts`; run it with:

```powershell
npm test -- --runInBand scripts/assignment-seed-data.spec.ts
```

The seed command writes to PostgreSQL. Do not run it against a production, shared, or otherwise valuable database.

## Benchmark harness

The reproducible baseline, during-bulk, and manual crash/recovery benchmark commands are documented in [docs/BENCHMARKS.md](./docs/BENCHMARKS.md). Actual local baseline, 50,000-item bulk, and operator-attested crash/recovery measurements are documented there. The harness uses the existing opportunity-list and bulk-job APIs; it does not connect to PostgreSQL or manage processes. Match request rate and concurrency between baseline and during-bulk runs, but their actual measurement durations differ and are reported separately. There is no warm-up period, so connection establishment/reuse may affect latency percentiles. Crash-recovery requires a single worker, remains operator-attested, and cannot independently prove which process caused progress. Bulk scenarios require exactly 50,000 matched items.

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

The lookup is scoped by both workspace and job. Missing and cross-workspace jobs return `404 resource_not_found`. The response contains persisted job state, with `pendingCount = matchedCount - processedCount`; failure messages are returned as a safe generic message rather than exposing internal details. The response builder currently returns `waitingReason: null`; this endpoint does not expose wait-state detection.

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

The internal `BulkJobLeaseService` provides `claimNext(workerId)`, `renew(token)`, `deferIfNoDueItems(token)`, and `yieldAfterQuantum(token)` for the worker process. Claims atomically select queued jobs or running jobs with expired leases using PostgreSQL row locking and database time. Both paths require at least one pending item whose item-level `nextAttemptAt` is null or due; the job-level schedule is not an eligibility gate. A successful claim sets status to `running`, assigns the owner and expiry, updates the heartbeat, increments `leaseGeneration`, sets `startedAt` only once, and clears the job scheduling hint. Renewal succeeds only while the matching job ID, owner, generation, running status, and unexpired lease still match. After five completed batch or recorded retry attempts, `yieldAfterQuantum` locks and validates the job, then requeues due pending work and clears its lease, or—if all pending work is in the future—sets the job hint to the earliest pending-item time and clears the lease. Neither path changes item state, progress, retry count, heartbeat, cursor, or lease generation. Item schedules remain authoritative. Deferral distinguishes deferred work, lost leases, due items remaining, and jobs with no pending items; yield distinguishes yielded work, deferred work, lost leases, and jobs with no pending items. Transaction errors propagate; the worker treats an ambiguous outcome as a reason to discard the token. No eligible job returns `{ "kind": "empty" }`.

The caller supplies a stable worker ID; the service does not generate one. `BULK_JOB_LEASE_DURATION_MS` configures lease duration, defaulting to 30,000 milliseconds and accepting values from 1,000 through 300,000 milliseconds. Claims and renewals use PostgreSQL time.

`BulkJobProcessingService.processBatch(token)` performs one bounded batch for a supplied lease token. `BULK_JOB_BATCH_SIZE` defaults to 100 and accepts values from 1 through 500. The method locks the job row before validating the owner, generation, running status, and database-time lease expiry, and keeps that lock through the batch transaction. It selects due pending items by `itemId`; it does not use or advance `cursorItemId`, so ID gaps and pending retries behind a cursor remain visible. Successful moves, stale-snapshot/already-at-destination skips, transitions, item outcomes, and progress counters commit atomically. Jobs become terminal only when every matched item has a terminal outcome. A stale token returns `{ "kind": "lease_lost" }`, and a job without due pending items returns `{ "kind": "no_due_pending_items" }`.

The method does not itself poll or schedule work. The worker repeatedly invokes it while it owns a job. Unexpected processing/database errors are surfaced and roll back the entire batch, leaving selected items pending and progress unchanged; no item is permanently failed by this operation. Recognized Prisma transaction conflicts and PostgreSQL serialization/deadlock errors also record the affected pending item's attempt count and error code in a separate lease-fenced transaction after rollback. That item remains pending but is deferred by `BULK_JOB_RETRY_BACKOFF_MS`, default 30,000 milliseconds, configurable from 1,000 through 3,600,000 milliseconds. This finite fixed delay prevents immediate re-selection while allowing later items to progress. A `RetryableBulkJobProcessingError` exposes the affected item ID, original error as `cause`, and whether retry metadata was recorded, skipped because the lease/item was no longer eligible, or failed. The worker's separate deferral transaction handles future-only pending items; the lease token fences each batch and deferral operation independently. The read-only zero-pending diagnostic does not mutate or reconcile anomalous jobs.

### API tests

The end-to-end suite uses unique workspace fixtures in the configured PostgreSQL database and removes only those fixtures afterward. It does not reset the database. Configure `DATABASE_URL` and apply the reviewed migrations before running:

```powershell
npm run db:migrate:deploy
npm test
npm run test:e2e
```
