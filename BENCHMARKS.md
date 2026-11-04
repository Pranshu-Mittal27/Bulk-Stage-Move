# Bulk Stage Move Benchmarks

## Scope and environment

This document reports the primary bulk and crash-recovery experiments.
Interactive probes use the read-only opportunity-list endpoint. These are
individual local runs, not statistically controlled repeated experiments.
The run numbers below identify the experiments retained in the final submitted
evidence; they do not claim these were necessarily the first experiments ever
performed.

| Environment        | Value                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| OS / shell         | Windows, PowerShell                                                                                   |
| CPU                | 13th Gen Intel Core i5-1335U, 10 cores, 12 logical processors                                         |
| RAM                | 15.69 GB                                                                                              |
| Node.js / npm      | v22.23.4 / 10.9.9                                                                                     |
| PostgreSQL         | 18.6, local server                                                                                    |
| Dataset            | 515,000 opportunities across 6 workspaces                                                             |
| Large workspace    | Same workspace used by the bulk job: 500,000 opportunities across 12 uneven stages                    |
| Small workspaces   | Different workspaces from the bulk-job workspace: 2,000; 2,500; 3,000; 3,500; and 4,000 opportunities |
| Workers            | One worker for bulk and crash/recovery runs                                                           |
| Interactive probes | 2 requests/second per workspace, max concurrency 1 per workspace                                      |

RAM, npm/PostgreSQL versions, core count, and dataset details are
run-environment information rather than fields collected by every benchmark
artifact.

## Bulk processing

Bulk Runs 1 and 2 are the primary comparable bulk results retained in the
final submitted evidence. They used fresh,
independently seeded databases with the same 50,000-opportunity workload,
hardware, and single-worker configuration.

### Bulk Run 1

Source: [benchmarks/bulk-first.json](./benchmarks/bulk-first.json)

| Measure                                            |                   Result |
| -------------------------------------------------- | -----------------------: |
| Matched / processed / moved                        | 50,000 / 50,000 / 50,000 |
| Skipped / failed / pending                         |                0 / 0 / 0 |
| Total submission-to-terminal-observation time      |                416.180 s |
| Persisted job interval (`completedAt - startedAt`) |                412.154 s |
| Persisted-throughput interval result               |          121.314 items/s |
| Submission latency                                 |              2953.592 ms |

| Workspace |       p50 |       p95 |       p99 |
| --------- | --------: | --------: | --------: |
| Large     | 13.624 ms | 22.508 ms | 53.764 ms |
| Small     | 13.073 ms | 20.813 ms | 27.522 ms |

### Bulk Run 2

Source: [benchmarks/bulk-second.json](./benchmarks/bulk-second.json)

| Measure                                            |                   Result |
| -------------------------------------------------- | -----------------------: |
| Matched / processed / moved                        | 50,000 / 50,000 / 50,000 |
| Skipped / failed / pending                         |                0 / 0 / 0 |
| Total submission-to-terminal-observation time      |                420.403 s |
| Persisted job interval (`completedAt - startedAt`) |                417.368 s |
| Persisted-throughput interval result               |          119.798 items/s |
| Submission latency                                 |              2977.769 ms |

| Workspace |       p50 |       p95 |       p99 |
| --------- | --------: | --------: | --------: |
| Large     | 13.678 ms | 22.457 ms | 43.094 ms |
| Small     | 13.438 ms | 22.376 ms | 31.826 ms |

### Simple arithmetic average for Bulk Runs 1 and 2

The following are simple averages of the two comparable primary runs; they are
not a statistically rigorous estimate and do not guarantee production
performance.

| Measure              |        Average |
| -------------------- | -------------: |
| Completion time      |       418.29 s |
| Persisted throughput | 120.56 items/s |
| Submission latency   |     2965.68 ms |
| Large-workspace p95  |       22.48 ms |
| Large-workspace p99  |       48.43 ms |
| Small-workspace p95  |       21.59 ms |
| Small-workspace p99  |       29.67 ms |

The probes issue `GET /api/v1/opportunities?stageId=<stage>&limit=1`. Large
workspace probes measure latency from the same workspace used by the bulk job;
small-workspace probes measure a different workspace. Latencies are client-side
observations. Throughput is processed outcomes divided by the persisted job
interval, and is an aggregate interval average rather than a measured
steady-state rate.

## Crash recovery

Crash Run 1 is the primary recovery experiment retained in the final submitted
evidence. Its start report is
[benchmarks/crash-first-start.json](./benchmarks/crash-first-start.json), and
its resume report is
[benchmarks/crash-first-resume.json](./benchmarks/crash-first-resume.json).

The harness submitted a job for 50,000 matched opportunities. The worker was
stopped after the start report recorded 900 processed and moved opportunities,
leaving 49,100 pending. After an operator confirmed that the replacement worker
had started, the resume harness observed final completion: 50,000 processed,
50,000 moved, zero skipped, zero failed, and zero pending.

| Recovery measurement                                    |                      Result |
| ------------------------------------------------------- | --------------------------: |
| Submission-to-completion wall-clock time                |                   665.425 s |
| Restart confirmation to completion observation          |     approximately 600.974 s |
| Restart confirmation to first observed resumed progress |      approximately 88.594 s |
| Submission latency                                      |                 2747.607 ms |
| Persisted job throughput reported by harness            | approximately 75.58 items/s |

The restart-confirmation-to-first-observed-progress interval is exactly the
interval reported by the harness; it is not a direct OS process-start
measurement. The restart confirmation is an operator-confirmed `worker_started`
boundary. The harness does not independently verify which OS process caused
persisted progress. Submission-to-completion timing is UTC wall-clock timing
spanned across processes.

A separate direct final-state SQL verification confirmed the opportunity and
transition results for this crash-recovery experiment: 50,000 opportunities
were moved, 50,000 transition records were created, and 50,000 distinct
opportunities were represented in those transitions. It found zero incorrect
destination transitions and zero missing or unmoved opportunities.

The approximately 75.58 items/s value is persisted throughput over the recovery
report interval, including worker downtime. It is not comparable to the active
single-worker throughput from ordinary bulk Runs 1 and 2.

## Reproduction commands

Use a dedicated disposable local database that is independently confirmed to be
safe for benchmark mutations. PostgreSQL and the API must be running, and
exactly one worker should process each job. Do not allow another worker to
claim the benchmark job.

The benchmark implementation is `npm run benchmark:bulk`; it supports
`baseline`, `bulk`, `crash-start`, and `crash-resume`. The bulk and crash
scenarios use the seeded large workspace, source stage 1, target stage 2, and
an inclusive value range by default. They require exactly 50,000 matched
targets for the bulk scenarios. The mutating `bulk` and `crash-start` scenarios
require `--confirm-benchmark`.

Start the API with `npm run start:dev` and one worker in another terminal with
`npm run start:worker:dev`.

Run a fresh-database bulk scenario:

```powershell
npm run benchmark:bulk -- bulk --confirm-benchmark --request-rate 2 --concurrency 1 --timeout-seconds 3600 --output benchmarks/bulk-first.json
```

Change the output filename for the independently seeded Bulk Run 2 database. The
primary report values should come from the actual JSON generated by each run.

For crash recovery, create a fresh disposable seeded dataset and start the API
and worker, then run:

```powershell
npm run benchmark:bulk -- crash-start --confirm-benchmark --checkpoint benchmarks/crash-first-checkpoint.json --output benchmarks/crash-first-start.json
```

Stop only the verified worker PID after the harness reports its stop boundary,
then restart one worker manually. The harness does not verify process identity.

```powershell
npm run benchmark:bulk -- crash-resume --checkpoint benchmarks/crash-first-checkpoint.json --timeout-seconds 3600 --output benchmarks/crash-first-resume.json
```

On the crash-resume prompt, start one worker and wait for `worker_started`
before confirming. The harness records the operator-confirmed restart boundary;
it cannot prove which replacement process caused subsequent progress.

## Limitations

- Bulk Runs 1 and 2 and Crash Run 1 are individual local runs retained in the
  final submitted evidence, not
  statistically controlled repeated experiments.
- The simple bulk average is descriptive only; it has no statistical
  significance or production-scale guarantee.
- The interactive workload is read-only GET traffic and does not measure
  interactive writes or manual stage-move latency.
- CPU/RAM utilization, PostgreSQL execution plans, separate API/database
  resource use, and multi-worker scaling were not measured.
- The single-machine local environment is not production validation.
- The probes share one client process, use a low fixed rate, and have no
  controlled warm-up; local scheduling, networking, and connection reuse affect
  observations.
- Crash recovery is operator-attested. The harness verifies API-visible status
  and counters; the retained Crash Run 1 also has separate database-level
  opportunity and transition verification.
