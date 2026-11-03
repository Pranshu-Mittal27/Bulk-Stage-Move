# Trade-offs and Known Limitations

## Purpose and scope

This document records deliberate scope choices and verified limitations in the take-home implementation. The design prioritizes understandable, correct asynchronous bulk processing within a limited delivery window; it is not a claim of production readiness. Improvements below are follow-up options, not confirmed assignment requirements or evidence of current defects.

## Current design decisions

- **Decision:** Use a fixed internal maximum of five failed processing attempts per item.
  - **Rationale:** Prevent repeatedly conflicting items from remaining pending indefinitely and make exhaustion visible through the existing item/job status and counter fields without adding configuration or infrastructure.
  - **Alternatives considered:** Unlimited retries, an environment-configurable retry limit, and a separate dead-letter/retry subsystem.
  - **Trade-offs:** A repeatedly conflicting item may become failed even if the underlying database conflict could eventually resolve. The fifth retryable attempt is deliberately terminal; infrastructure, connection, timeout, and unknown errors are still left on the worker error path rather than being misclassified as item failures.
- PostgreSQL is the system of record for opportunities, bulk-job snapshots, item outcomes, progress, and the durable job queue. The worker uses the same database; no external queue is required.
- Submission persists a workspace-scoped idempotency key and a snapshot of matching opportunities with their expected stage and version. The submission transaction enforces the 50,000-item maximum.
- The worker processes bounded batches sequentially. Successful stage changes, transition history, item outcomes, and progress changes are committed atomically.
- Job claims and mutations use PostgreSQL transactions, row locks, lease expiry checks, and generation fencing. Item-level retry schedules determine eligibility; the job-level schedule is only a hint.
- Recognized transient database conflicts receive a finite retry delay and are retried at most five failed processing attempts per item. Other batch failures roll back and are surfaced rather than silently converted into item outcomes.

## Known limitations and accepted trade-offs

### Basic job yielding does not provide workspace fairness

- **Current behavior:** A worker yields after at most five completed batches or recorded retry attempts when pending work remains. Empty polls while due rows are locked do not consume the quantum. Eligible jobs are ordered by oldest `lastProgressAt`, falling back to `createdAt`, using `SKIP LOCKED`. This lets older-waiting eligible jobs run before a recently progressed job, but does not weight or partition by workspace.
- **Impact:** The bounded quantum improves job-level scheduling opportunities but does not guarantee strict fairness or prevent starvation. A busy workspace can still consume worker capacity, and all workers still share database resources with the API.
- **Why limited:** A small fixed quantum and existing progress timestamp avoid schema and infrastructure changes while preserving the durable lease model. They do not implement a tenant-level scheduling policy.
- **Possible next-week improvement:** Measure queue wait time by workspace under a representative mixed-workload test, agree on a fairness objective, then evaluate whether workspace-aware scheduling is warranted.

### Due work can cause polling when its item rows remain locked

- **Current behavior:** Batch selection skips locked item rows. If no item can be selected but due pending items still exist, the worker waits with bounded jitter, checks again, and renews the lease only when its renewal interval is reached. The worker README documents this behavior.
- **Impact:** A long-held item lock can keep a worker occupied polling and renewing instead of making progress on another job.
- **Why deferred:** The existing behavior avoids a tight retry loop and preserves job ownership while the due work is temporarily unavailable; changing job scheduling around row locks needs concurrency evidence.
- **Possible next-week improvement:** Use a PostgreSQL lock-contention test to measure the wait pattern and lease behavior, then decide whether a bounded wait limit or a diagnostic is warranted.

### Zero-pending anomalies are reported, not reconciled

- **Current behavior:** The worker emits an anomaly warning when deferral finds no pending items and periodically runs a read-only diagnostic for queued/running jobs without pending items. The query returns at most 20 jobs per run. It does not mark jobs complete, requeue them, or otherwise mutate state.
- **Impact:** An anomalous job remains visible in its existing state and may require operator investigation. If more than 20 anomalies exist, a single diagnostic run reports only the first 20 ordered results.
- **Why deferred:** Automatically inferring successful completion from the absence of pending items could hide inconsistent progress or lost outcomes. A general reconciliation subsystem is outside the initial scope.
- **Possible next-week improvement:** Define an operator response and inspect real anomaly frequency first. If needed, add an explicitly authorized, auditable repair procedure with tests for inconsistent counters and terminal outcomes.

### The status response does not expose a wait reason

- **Current behavior:** The bulk-job response builder always returns `waitingReason: null`; the status endpoint does not calculate why a job is waiting. The worker and its logs do handle deferred scheduling.
- **Impact:** API clients cannot distinguish a queued job waiting for a future retry from other queued states using this field.
- **Why deferred:** Returning a stable status response was kept separate from adding wait-state derivation and API semantics.
- **Possible next-week improvement:** Agree on the meanings and lifecycle of wait reasons before exposing them, then derive the value from persisted state and cover it in API tests.

### Production-scale behavior remains unverified

- **Current behavior:** The repository includes the `benchmark:bulk` command and a reproducible benchmark harness. The latest local 50,000-item bulk and operator-attested crash/recovery runs are documented in `BENCHMARKS.md`; no baseline and during-bulk result pair is included in the current final report. Adding baseline comparisons remains future work.
- **Impact:** These single local runs provide observed persisted end-to-end throughput and interactive latency for the tested workload. They do not establish isolated worker processing rate, production-scale capacity, performance at larger data volumes, or a stable causal estimate of bulk work's latency impact. Database contention and bottlenecks remain unverified.
- **Why deferred:** Correctness and transaction behavior were established first. The initial local measurements are not repeated or representative-environment evidence for production performance claims.
- **Possible next-week improvement:** Repeat the documented scenarios and test representative mixed/higher-load workloads in a representative environment; record hardware and configuration, and inspect contention before tuning or making capacity claims.

### One active job per worker process and fixed batch size

- **Current behavior:** Each worker process claims one job and processes up to five completed batches or recorded retry attempts before yielding pending work. Batch size is fixed for that process through `BULK_JOB_BATCH_SIZE` (default 100, bounded from 1 to 500). Multiple worker processes can run concurrently.
- **Impact:** Yielding gives other eligible jobs an opportunity to run, but does not reserve database capacity for API traffic or guarantee interactive latency. The chosen batch size and quantum are not automatically adjusted to database load or job size.
- **Why limited:** Sequential processing with a fixed, bounded quantum keeps transactions and worker logic understandable while allowing deployment-time batch sizing and multiple worker processes.
- **Possible next-week improvement:** Benchmark representative job sizes and worker counts, inspect database contention and latency, then tune the batch size or process count based on measured results.

## Not intentionally weakened

The implementation retains workspace isolation, idempotent submission, snapshot semantics and the item limit, atomic stage changes with transition history, optimistic version checks, durable per-item outcomes, bounded batch processing, lease ownership and expiry validation, generation fencing, retry eligibility, deferred scheduling, and progress-counter invariants. These correctness mechanisms should not be removed merely to reduce code size.

## Suggested next-week priorities

1. **Strengthen performance evidence.** Repeat the existing local scenarios and define representative workloads/environment for submission, persisted end-to-end throughput, and interactive latency; capture query plans and contention before proposing optimizations.
2. **Assess queue fairness with evidence.** Measure queue wait time by workspace and job under mixed load, then decide whether the current oldest-eligible ordering is insufficient.
3. **Investigate lock-wait behavior.** Exercise due items held by competing transactions and measure polling, lease renewals, and time to resume.
4. **Clarify operational handling of anomalies and wait reasons.** Review observed anomaly frequency and client needs before adding reconciliation or exposing new API state.

These are investigation priorities, not commitments to add production infrastructure or features. The original assignment prompt was not available in the repository during this review, so this document makes no claims about unverified rubric requirements.
