# Bulk Stage Move Design

## Scope and evidence

This document describes the implementation in this repository against the Bulk Stage Move take-home requirements. It distinguishes implemented behavior and test evidence from measured results, assumptions, and unverified production-scale hypotheses.

The service uses PostgreSQL as both the system of record and the durable job queue. The API and worker are separate processes from the same codebase. Workspace IDs scope records and requests, but the workspace header is not authentication.

## Chunking and transaction boundaries

Submission validates the workspace and destination stage, then counts and snapshots matching opportunities in one PostgreSQL `REPEATABLE READ` transaction. The snapshot is a set-based `INSERT ... SELECT` that stores one `BulkJobItem` per target, including the opportunity ID, stage, and stage version observed by the transaction. The request is rejected if more than 50,000 opportunities match. The job and complete snapshot become visible together at commit; an error rolls the transaction back. Submission has a 10-second transaction-acquisition wait and a 60-second transaction timeout.

Processing is divided into sequential batches. `BULK_JOB_BATCH_SIZE` defaults to 100 and accepts 1–500 items. Each batch runs in one `READ COMMITTED` transaction with a 10-second acquisition wait and a 60-second timeout. It locks the job, selects due pending items in item-ID order using `FOR UPDATE SKIP LOCKED`, locks the corresponding opportunities in deterministic ID order, and writes stage changes, transition history, item outcomes, and job counters atomically. A failed batch transaction does not leave a partial batch of business updates.

The cap bounds the amount of work and lock duration in each worker transaction; it also means processing is not one transaction for all 50,000 items. Larger batches reduce transaction frequency but increase the work held in one transaction. Smaller batches trade shorter transactions for more database round trips. These are design considerations, not measured performance conclusions.

## Durable progress, cursor, and indexes

The durable work list is `BulkJobItem`, not an in-memory offset. Each item remains `pending` until a transaction records a terminal outcome; `attemptCount`, `nextAttemptAt`, `lastErrorCode`, and `processedAt` preserve retry or completion state. The worker selects pending items whose retry time is absent or due, ordered by `itemId`. It can resume by querying those persisted rows after restart.

`BulkJob.cursorItemId` exists in the schema but the current processor neither advances nor uses it to select work. In particular, an advanced cursor does not prevent earlier due pending items from being processed; the database-backed processing suite covers that case. The durable per-item states and due-time predicate are authoritative.

The schema defines:

- `BulkJobItem(jobId, status, nextAttemptAt, itemId)` for due-item selection, plus unique `(jobId, opportunityId)` and `(jobId, itemId)` constraints.
- `BulkJob(status, nextAttemptAt, createdAt)` and `(status, leaseExpiresAt)` for queue and lease lookups.
- `Opportunity(workspaceId, stageId, id)` for workspace/stage listing and `(workspaceId, ownerId, status, id)` for owner/status access.
- `OpportunityTransition(workspaceId, opportunityId, createdAt)` for an opportunity's transition history.

The bulk filter also supports value and creation-time bounds; those columns are not covered by dedicated filter indexes in the current schema. Index definitions do not prove which plan PostgreSQL will choose. Query plans and index effectiveness have not been measured.

## Idempotency and target snapshot

`Idempotency-Key` is unique within a workspace. Before comparison, the service normalizes the workspace and stage UUIDs, decimal values to four fractional digits, timestamps to UTC at PostgreSQL microsecond precision, and absent filter fields to `null`. It canonicalizes the request (including API version, workspace, target stage, and filters) and stores both the normalized request and its SHA-256 hash.

The first accepted request creates one job and one target snapshot. A retry with the same workspace, key, and canonical request returns that persisted job; reusing the key for a different canonical request returns `409 idempotency_key_reused`. The unique database constraint arbitrates concurrent requests using the same key. Idempotency state is durable in PostgreSQL; no retention or key-expiration policy is implemented here.

Targets are determined at submission commit, not by re-running the filter during processing. Opportunities created afterward are excluded. The processor compares each target's current stage and `stageVersion` with the snapshot. An opportunity already at the destination is recorded as skipped; a different stage or version is recorded as `stale_snapshot`, without overwriting the intervening stage change. This is a stage/version check, not a full-row snapshot: changes unrelated to stage/version do not independently invalidate the target.

## Single-opportunity concurrency

Manual stage changes require `expectedStageVersion`. The API locks the workspace-scoped opportunity row, checks the expected version, and conditionally updates its stage while incrementing the version. A successful move and its `manual` transition are committed together. A stale version returns `409 stage_version_conflict`; requesting the existing stage with the current version is a no-op.

Bulk processing uses the same stage-version guard against the submission snapshot and records a `bulk` transition only for a successful move. Both paths lock the opportunity row and update against the expected stage/version. If a manual change wins first and moves the opportunity to the bulk job's target stage, the bulk item is skipped with reason `already_at_destination`; otherwise, if its stage or version no longer matches the snapshot, it is skipped with reason `stale_snapshot`. If bulk wins first, a manual request based on the old version conflicts. A later manual request using the new version can proceed. This is optimistic concurrency with row locking, not a promise that manual work always wins regardless of ordering. The dedicated manual-vs-bulk concurrency E2E test deterministically exercises the bulk-first ordering. It uses PostgreSQL advisory-lock and row-lock observation to establish that bulk processing holds the opportunity lock while a manual API request waits. After bulk commits, the manual request receives `409 stage_version_conflict`. The test verifies the final opportunity, item outcome, job counters, and transition history.

A separate stale-snapshot test verifies that a pre-existing stage/version change is not overwritten by bulk processing. The reverse ordering has not been exercised as a synchronized API-vs-worker race.

## Isolation, scheduling, and starvation

Workspace predicates, workspace-scoped unique constraints, and composite foreign keys keep job snapshots and opportunity operations within their workspace. Submission uses `REPEATABLE READ`; worker claim and deferral use short `READ COMMITTED` transactions; batch processing also uses `READ COMMITTED` with explicit row locks. The locks coordinate transactions sharing PostgreSQL rows; they do not isolate database CPU, I/O, connections, or locks by tenant.

Each worker process handles one claimed job at a time, processing up to five completed batches or recorded retry attempts before yielding when pending work remains. Empty polls while due rows are locked do not consume the quantum. Yielding requeues the job and releases its lease in one fenced transaction. Claims use `SKIP LOCKED` and order eligible jobs by oldest `lastProgressAt`, falling back to `createdAt`, so recently progressed jobs move behind jobs that have waited longer. This is basic job-level scheduling fairness only: there is no workspace-weighted scheduling, per-workspace quota, strict fairness, or starvation-prevention guarantee. A busy workspace can still consume shared database and worker capacity. The local benchmark recorded interactive latency during one bulk run, but does not establish fairness, rule out starvation, or predict interactive impact in production. Yielding does not isolate database resources or guarantee API latency.

## Failure recovery and test evidence

A claim marks a job `running` and stores a lease owner, expiry, heartbeat, and incremented `leaseGeneration`. The worker renews the lease between batches except at a yield boundary, and, when waiting on due work, as needed; it does not heartbeat inside a running batch. Batch writes validate owner, generation, status, and lease validity; an expired worker's stale token cannot continue after a newer generation claims the job. A crashed process leaves its lease to expire. Another worker can reclaim an expired running job when due pending items remain, incrementing the generation and continuing from persisted item state.

Recognized transient database conflicts (including serialization/deadlock conflicts) roll back the batch and persist an attempt count, error code, and retry time for the active pending item. `BULK_JOB_RETRY_BACKOFF_MS` defaults to 30 seconds and is bounded from 1 second to 1 hour; item schedules determine eligibility, while the job schedule is a hint. Future-only pending work is deferred and re-queued for its earliest due time. There is no general attempt limit or dead-letter policy in the current processing path. Unexpected batch errors are surfaced after rollback; they do not create a failed item outcome. The schema contains `failed` states and counters, but no normal processing path that marks an item failed was identified.

The repository has unit coverage for worker-loop behavior and configuration bounds, and database-backed end-to-end cases for submission/idempotency/snapshots, atomic batches, stale targets, retries, lease expiry/reclaim, fencing, and concurrent claims. These test cases are coverage evidence, not a claim that database-backed tests were run for this document. A local manual crash/recovery run is recorded in `docs/BENCHMARKS.md`; it is operator-attested and cannot independently prove which OS process caused subsequent progress.

## Risks to measure at 10x

At substantially higher data or job volume, plausible pressure points include the one-time snapshot count and insert transaction, growth of per-item and transition rows and their indexes, filtering by value/date without dedicated indexes, sequential per-item row locking inside each batch, and contention between API traffic and workers on shared PostgreSQL resources. Pool sizing is not explicitly configured in the Prisma adapter construction and should be checked against the combined API/worker process count and database connection limit. Queue wait time may also grow because workers each handle one job at a time and there is no workspace fairness policy.

These are hypotheses grounded in the implementation, not proven bottlenecks. The per-job matched-item limit remains 50,000; “10x” does not change that limit. A single local run measured 50,000-item persisted end-to-end throughput and interactive latency during bulk work, as documented in `docs/BENCHMARKS.md`. It did not measure isolated worker processing rate, 10x capacity, query plans, connection saturation, or production performance.

## Ranked next-week improvements

1. **Strengthen the performance evidence.** Repeat the documented baseline, 50,000-item, interactive, and manual recovery scenarios and test representative higher or mixed loads on verified disposable environments. Preserve the JSON and record client/server hardware, PostgreSQL version/configuration, worker count, and actual durations before making capacity claims.
2. **Measure isolation and queue behavior.** Use a mixed-workspace workload to record queue wait and interactive latency by workspace; test concurrent jobs and lock contention. Decide on a fairness objective from evidence before changing scheduling.
3. **Extend recovery and failure evidence.** The documented single-worker crash/restart experiment has an initial operator-attested local result; repeat it and separately verify lease expiry, persisted progress, retry delays, and the operator procedure. Define an explicit response for repeated permanent errors and zero-pending anomalies before adding automatic reconciliation.
4. **Use measurements to guide database tuning.** Inspect representative `EXPLAIN (ANALYZE, BUFFERS)` plans, connection usage, and transaction durations. Add or change indexes, pool sizing, or batch size only when those observations identify a concrete need.

The harness and the initial local results are documented in `docs/BENCHMARKS.md`; remaining trade-offs and limitations are documented in `docs/TRADEOFFS.md`. The recorded measurements are single-run local evidence, not production-capacity or exactly-once proof.
