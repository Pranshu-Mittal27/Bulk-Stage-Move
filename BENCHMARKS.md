# Bulk Stage Move Benchmarks

## Scope and environment

These artifacts report the latest recorded 50,000-item bulk run and one
operator-coordinated worker crash/recovery run. Interactive probes use the
read-only opportunity-list endpoint. Only one result set is retained; these
are individual local runs, not statistically controlled repeated experiments.

| Environment        | Value                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| OS / shell         | Windows, PowerShell                                                                                   |
| CPU                | 13th Gen Intel Core i5-1335U; 10 cores, 12 logical processors                                         |
| RAM                | 15.69 GB                                                                                              |
| Node.js / npm      | v22.23.4 / 10.9.9                                                                                     |
| PostgreSQL         | 18.6, local server                                                                                    |
| Dataset            | 515,000 opportunities across 6 workspaces                                                             |
| Large workspace    | Same workspace used by the bulk job: 500,000 opportunities across 12 uneven stages                    |
| Small workspaces   | Different workspaces from the bulk-job workspace: 2,000; 2,500; 3,000; 3,500; and 4,000 opportunities |
| Workers            | One worker for bulk and crash/recovery runs                                                           |
| Interactive probes | 2 requests/second per workspace; max concurrency 1 per workspace                                      |

RAM, npm/PostgreSQL versions, core count, and dataset details are run-environment
information, not fields collected by the benchmark harness.

## Latest results

### Bulk processing

The [bulk result](./benchmarks/bulk.json) completed successfully:

| Measure                                            |                   Result |
| -------------------------------------------------- | -----------------------: |
| Matched / processed / moved                        | 50,000 / 50,000 / 50,000 |
| Skipped / failed / pending                         |                0 / 0 / 0 |
| Total submission-to-terminal-observation time      |                252.265 s |
| Persisted job interval (`completedAt - startedAt`) |                249.143 s |
| Aggregate persisted-interval throughput            |          200.688 items/s |
| Submission latency                                 |              2,060.95 ms |

During the bulk run, the large and small workspace probes each made 505 requests
with zero errors:

| Workspace |      p50 |       p95 |       p99 |
| --------- | -------: | --------: | --------: |
| Large     | 7.302 ms | 16.324 ms | 42.839 ms |
| Small     | 7.281 ms | 14.918 ms | 30.731 ms |

The probes issue `GET /api/v1/opportunities?stageId=<stage>&limit=1`. Latencies
are client-side observations. Throughput is processed outcomes divided by the
249.143-second persisted job interval (50,000 / 249.143 = approximately
200.688 items/second). This is an aggregate interval average, not a measured
steady-state rate. The separate end-to-end submission-to-terminal-observation
time was 252.265 seconds.

### Crash recovery

The [crash-start result](./benchmarks/crash-start-2026-11-02T20-31-00.014Z.json)
records 6,600 processed/moved and 43,400 pending at operator-confirmed worker
stop. The [crash-resume result](./benchmarks/crash-recovery.json) records
status `completed`: 50,000 matched, processed, and moved; zero skipped, failed,
or pending. The harness verifies API-visible job status and counter invariants;
it does not read back the final stage of every opportunity.

Separately, a post-run direct SQL verification was also performed. It verified
50,000 total opportunities in the job, 50,000 moved to the target stage,
50,000 opportunities at the target stage and zero not at the target stage, zero
missing opportunities, 50,000 transition records, 50,000 distinct opportunities
represented in those transitions, and zero transitions to an incorrect
destination. This was a separate database-level verification, not something the
benchmark harness performs automatically. It does not prove the absence of
every retry or reprocessing event during execution.

Progress was 6,600 processed at worker stop and 8,000 at the fresh
restart-confirmation baseline, followed by observed persisted progress 1,124 ms
after confirmation. This is evidence of durable progress and subsequent
advancement; it does not prove the absence of every duplicate or reprocessing
event. From restart confirmation to terminal completion observation was
133.022 seconds. The replacement worker's actual OS process-start timestamp was
not recorded, so this is not an exact process-start-to-completion measurement.
The derived interval from operator-confirmed worker stop to terminal completion
observation was 253.466 seconds; these are confirmation/observation timestamps,
not independently measured process lifecycle events.

The persisted job interval was 329.999 seconds, corresponding to approximately
151.516 processed items/second over the overall persisted interval, not
resume-only throughput. The 1,724.80 ms submission latency in the resume
artifact is reused from the original job submission and is not restart latency.
Submitted-to-completion observation across processes was 332.937 seconds.

## Running and reproducing

Use a dedicated disposable local database with the seeded dataset. Verify the
database server and target independently; a database name alone does not prove
that a database is disposable. Keep PostgreSQL and the API running. Start the
API with `npm run start:dev` and one worker in another terminal with
`npm run start:worker:dev`. Do not allow another worker to claim the job.

The benchmark script is `npm run benchmark:bulk`; it supports `baseline`,
`bulk`, `crash-start`, and `crash-resume`. The bulk and crash scenarios use the
seeded large workspace, source stage 1, target stage 2, and inclusive value
range `101.0000`–`25100.0000` by default. The harness requires exactly 50,000
matched targets for these scenarios. Output paths are overwritten if they
already exist; choose unused paths when preserving the recorded artifacts.
The mutating `bulk` and `crash-start` scenarios require the explicit
`--confirm-benchmark` flag. `baseline` and `crash-resume` do not require it.
The source-stage ID can be overridden by configuration, but the resolved
source-stage ID is not recorded in the result artifact; the artifact alone
therefore cannot establish the exact source-stage filter used for that run.

Run the standard bulk scenario with one worker already running:

```powershell
npm run benchmark:bulk -- bulk --confirm-benchmark --request-rate 2 --concurrency 1 --timeout-seconds 3600 --output benchmarks/bulk.json
```

For crash recovery, use a fresh disposable seeded dataset. Start the API and
worker, then run:

```powershell
npm run benchmark:bulk -- crash-start --confirm-benchmark --checkpoint benchmarks/crash-recovery-checkpoint.json
```

At the harness prompt, verify the worker process and stop only its verified PID
with `Stop-Process -Id <verified-worker-PID>`. Keep the API and PostgreSQL
running, wait for that worker process to exit, then press Enter. Do not stop a
process by name. The harness writes a timestamped crash-start result and the
local `benchmarks/crash-recovery-checkpoint.json` checkpoint. That checkpoint
is ignored by Git because it is tied to a specific local database and job.

With the worker stopped, run:

```powershell
npm run benchmark:bulk -- crash-resume --checkpoint benchmarks/crash-recovery-checkpoint.json --timeout-seconds 3600 --output benchmarks/crash-recovery.json
```

When prompted, start one worker with `npm run start:worker:dev`, wait for
`worker_started`, and press Enter. The harness records a fresh persisted
progress baseline and requires progress beyond it to report successful
recovery. The operator coordinates process stop/restart; the harness does not
independently verify which OS process caused the observed progress.

## Limitations

- Each reported scenario is a single local run, without repeated trials,
  confidence intervals, or statistical controls.
- The interactive workload is read-only GET traffic. It does not measure
  interactive writes or manual stage-move latency.
- The bulk run uses one worker. These results do not measure concurrent-worker
  scaling or establish production-scale performance.
- The measurements do not prove strict fairness, zero starvation, universal
  workspace isolation, or latency guarantees. Worker yielding schedules jobs;
  it does not reserve database connections, CPU, or I/O.
- CPU/RAM utilization, PostgreSQL configuration/execution plans, and separate
  API/database resource use were not measured. The local single-machine run is
  not production validation.
- The probes share one client process, use a low fixed rate, and have no warm-up;
  client scheduling, local networking, and connection reuse affect results.
- Crash recovery is operator-attested. The harness verifies API-visible status
  and counters but does not inspect every opportunity's final stage. A separate
  database-level final-state verification was performed after the run; it does
  not establish that no retry or reprocessing event occurred during execution.
