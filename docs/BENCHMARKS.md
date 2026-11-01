# Bulk Stage Move Benchmarks

## Status

**Measured results: Initial local measurements recorded below.** These are one run per scenario on one local workstation, not evidence of production capacity or a general exactly-once guarantee. The JSON files listed in the result tables are the detailed source records.

## Measured results

### Environment and dataset

| Field                      | Recorded value                                                       |
| -------------------------- | -------------------------------------------------------------------- |
| Operating system / shell   | Windows, PowerShell                                                  |
| CPU                        | 13th Gen Intel Core i5-1335U; 10 cores, 12 logical processors        |
| RAM                        | 15.69 GB                                                             |
| Node.js / npm              | v22.23.4 / 10.9.9                                                    |
| PostgreSQL                 | 18.6, local server                                                   |
| Dataset                    | 515,000 opportunities across 6 workspaces                            |
| Large workspace            | 500,000 opportunities across 12 uneven stages                        |
| Small workspaces           | 2,000; 2,500; 3,000; 3,500; and 4,000 opportunities                  |
| Interactive probe settings | 2 requests/second per workspace; maximum concurrency 1 per workspace |

The harness JSON independently records Windows, the CPU model, 12 logical processors, and Node.js v22.23.4. RAM, npm version, PostgreSQL version, core count, and dataset totals are the confirmed environment details supplied for this run, not fields recorded by the harness.

### Interactive latency

Values below are milliseconds. The delta is during-bulk minus baseline; the scenarios have different measurement durations and only one run each.

| Workspace | Baseline requests / errors |    Baseline p50 / p95 / p99 | During-bulk requests / errors | During-bulk p50 / p95 / p99 | p95 change |  p99 change |
| --------- | -------------------------: | --------------------------: | ----------------------------: | --------------------------: | ---------: | ----------: |
| Large     |                    241 / 0 | 12.8678 / 20.7903 / 34.2015 |                     1,120 / 0 | 15.1596 / 22.6175 / 51.2030 | +1.8272 ms | +17.0015 ms |
| Small     |                    241 / 0 | 13.1761 / 19.1348 / 29.1701 |                     1,119 / 0 | 14.1559 / 20.4774 / 28.6761 | +1.3426 ms |  -0.4940 ms |

The large-workspace p95 and p99 were higher during this bulk run; the small-workspace p95 was higher while its p99 was slightly lower. These are observed values from one run, not evidence of a stable causal effect or a production latency guarantee.

### Bulk and crash/recovery outcomes

| Scenario / source JSON                                               | Outcome and counters                                                                                                                                                                                                                              | Timing and throughput                                                                                                                                                                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline — `benchmarks/baseline.json`                                | Both workspaces had zero request errors.                                                                                                                                                                                                          | Interactive measurement: 120.047 s (about 120.05 s).                                                                                                                                                                        |
| During bulk — `benchmarks/during-bulk.json`                          | `completed`; 50,000 matched, processed, and moved; 0 skipped, 0 failed, 0 pending.                                                                                                                                                                | Submission: 1,798.14 ms. Total completion elapsed: 559.498 s. Interactive measurement: 559.528 s. Persisted job interval: 556.768 s; persisted throughput: 89.804 processed outcomes/s and 89.804 moved opportunities/s.    |
| Crash start — `benchmarks/crash-start-2026-11-01T20-08-19.103Z.json` | At the prompt, the earlier `progressImmediatelyBeforeStop` snapshot was 100/50,000. After the operator confirmed the worker had stopped, the fresh `progressAtStop` snapshot was 15,300 processed and moved, 0 skipped or failed, 34,700 pending. | Submission: 2,250.58 ms.                                                                                                                                                                                                    |
| Crash resume — `benchmarks/crash-recovery.json`                      | `PASS`; final job `completed` with 50,000 matched, processed, and moved; 0 skipped, 0 failed, 0 pending. At restart confirmation, the persisted baseline was 18,100 processed.                                                                    | Persisted job interval: 503.190 s; persisted throughput: 99.366 processed outcomes/s and 99.366 moved opportunities/s. Restart-confirmation to observed progress: 1,173 ms. Submitted-to-completion observation: 506.390 s. |

The crash/recovery procedure was operator-attested: the worker was manually stopped and restarted while the API and PostgreSQL remained running. The harness records progress snapshots and requires a post-restart increase beyond its fresh baseline, but does not independently verify which OS process advanced the job.

The reported throughput values are **persisted end-to-end job rates**, calculated from final persisted counters divided by the persisted `completedAt - startedAt` interval. They are not isolated worker processing rates: the interval can include lifecycle, retry/deferred, and—during recovery—interruption time. No measurement here separates application processing time from database time.

These results show the recorded job counters reached their expected terminal values in these runs. They do not prove exactly-once processing beyond the API-visible status/counter invariants, nor do they establish production-scale capacity.

## Prerequisites and setup

- Use a dedicated disposable PostgreSQL database populated using the assignment seed instructions in the README. Do not benchmark a valuable or production database.
- Independently verify the PostgreSQL server and database before running migrations or seed commands. The seed's database-name guard does not establish server identity or prove that a database is disposable.
- Use a local-only or otherwise isolated API endpoint. The current API uses `X-Workspace-Id` for scoping, not authentication; do not expose a benchmark instance to untrusted networks.
- Confirm the seed has completed, the large workspace has 500,000 opportunities, and the five small workspaces have their documented counts.
- Set up three terminals: API, worker (for `bulk` and crash scenarios), and benchmark client. The API and PostgreSQL remain running throughout.
- Run exactly one worker for the experiment. No other worker instance may be running or able to claim the benchmark job, especially during crash/recovery.

The API is started with `npm run start:dev`. The worker is started separately with `npm run start:worker:dev`. Build first if using the compiled entry points.

Default benchmark workspace/stage IDs correspond to the deterministic seed IDs. Override them through the listed CLI options or environment variables when using a different compatible dataset. The bulk scenario's source is stage position 1 in the large workspace, and its target defaults to stage position 2.

Bulk and crash-start scenarios move matching opportunities out of the source stage. Run the baseline before its corresponding bulk run, with no other queued or running bulk jobs (preferably with the worker stopped). Use a freshly prepared and seeded disposable database for every subsequent bulk or crash experiment. The seed script does not reset moved opportunities. If submission succeeds but the returned count is not 50,000, the harness fails without polling it as a valid benchmark. Its failure JSON and message identify the created job and workspace and warn that the job may continue running; no cancellation or cleanup is attempted.

## Commands

Use the same request rate and concurrency for baseline and during-bulk runs. Their actual measurement durations differ: baseline runs for the configured duration, while the bulk workload runs through terminal job observation (or timeout). Compare and report each scenario's measured duration; do not describe the runs as duration-matched.

```powershell
npm run benchmark:bulk -- baseline --request-rate 2 --concurrency 1 --duration-seconds 120 --output benchmarks/baseline.json
```

For the bulk run, start the worker first, then run:

```powershell
npm run benchmark:bulk -- bulk --request-rate 2 --concurrency 1 --timeout-seconds 3600 --output benchmarks/during-bulk.json
```

Each command produces a JSON result file and a console summary. A bulk result is considered successful only if the API reports exactly 50,000 matched items and the job reaches `completed` with 50,000 persisted outcomes, zero pending items, and zero failures. A different match count fails the run; it is not treated as a smaller benchmark.

The default bulk filter is `stageId = <large stage position 1>` and inclusive `valueRange = { min: "101.0000", max: "25100.0000" }`. In the assignment seed, stage 1 contains opportunity numbers 1 through 125,000, and generated values map that range to exactly 50,000 items. The API's returned `matchedCount` is the authoritative guard. The target stage must be a different stage in the same workspace.

### Crash and resume (manual)

1. Start the API and worker, then run:

   ```powershell
   npm run benchmark:bulk -- crash-start --checkpoint benchmarks/crash-recovery-checkpoint.json
   ```

2. The harness submits the same exactly-50,000-item job, waits for persisted progress, then performs a fresh status read and prints the latest durable counters immediately before asking you to stop the worker.
3. For an abrupt-crash test on Windows, identify the exact worker PID in Task Manager (verify its command line/role), then manually terminate only that PID from PowerShell:

   ```powershell
   Stop-Process -Id <verified-worker-PID>
   ```

   Never terminate processes by name. Do not stop the API or PostgreSQL, and ensure no other worker can claim the job. Wait until the worker process has exited, return to the benchmark terminal, and press Enter. The harness records the durable pre-stop progress and performs another persisted status read after the operator confirms termination. If the job becomes terminal before this checkpoint, the scenario is reported as failed. Ctrl+C sends a graceful shutdown signal and is not equivalent to this abrupt-crash experiment.

4. Run the resume command while the worker is still stopped:

   ```powershell
   npm run benchmark:bulk -- crash-resume --checkpoint benchmarks/crash-recovery-checkpoint.json --timeout-seconds 3600 --output benchmarks/crash-recovery.json
   ```

5. When prompted, restart the worker manually with `npm run start:worker:dev`. After its `worker_started` event appears, press Enter in the benchmark terminal. The harness immediately reads and records a fresh persisted progress baseline. If the job is already terminal at this confirmation boundary, the recovery scenario fails and cannot claim successful recovery. Otherwise, it polls until persisted `processedCount` exceeds that fresh baseline; a status change alone is not resumed progress. The reported `restartConfirmationToObservedProgressMs` is a monotonic interval from operator confirmation to the first observed increase, not from actual OS process start. This is operator-attested: the harness does not independently prove which OS process caused progress. End-to-end time across the separate start/resume processes uses UTC timestamps and includes operator delay. Successful recovery requires a terminal `completed` job, a progress increase after the restart-confirmation baseline, consistent persisted counters, 50,000 processed outcomes, and no pending or failed items.

## Request workload and metrics

The interactive probe is the existing read-only request:

```http
GET /api/v1/opportunities?stageId=<stage-id>&limit=1
X-Workspace-Id: <workspace-id>
```

It exercises the existing workspace-scoped, stage-filtered opportunity listing path without changing data and with a one-row page. The same request settings are run independently against the large and one small workspace. Output separates request counts, HTTP errors, transport errors, and p50/p95/p99 latency for each.

`--request-rate` is requests per second **per workspace**; `--concurrency` is the maximum in-flight requests **per workspace**. The baseline uses `--duration-seconds`; the bulk workload continues from before submission through terminal job observation, bounded by `--timeout-seconds`. The JSON reports `interactiveMeasurementDurationMs` for each scenario; actual durations differ and are not matched. Both modes use the same scheduler and endpoint. This is a fixed-rate client load model, not an open-loop industrial load generator: when the concurrency limit is reached, the scheduler waits for an active request and does not queue an unbounded backlog. Request latency includes response-body consumption. There is no warm-up period; connection establishment and reuse may affect latency percentiles. Results are client-side and include client/network scheduling effects.

Reported bulk timings:

- **Submission latency:** monotonic duration for the submission HTTP request, measured independently.
- **Total completion elapsed duration:** monotonic time from immediately before submission through first observation of terminal status; includes submission, worker execution, and status polling. The JSON field is `totalCompletionElapsedMs`.
- **Persisted wall-clock interval:** `completedAt - startedAt`, when both persisted timestamps are present and valid. This is derived from database timestamps, not a monotonic clock; it is reported as `persistedWallClockElapsedMs`.
- **Processed outcomes per persisted wall-clock second** (`processedItemsPerPersistedWallClockSecond`): `processedCount / persisted wall-clock interval seconds`. `processedCount` is the persisted count of moved + skipped + failed outcomes; this is not a retry-attempt rate.
- **Moved opportunities per persisted wall-clock second** (`movedOpportunitiesPerPersistedWallClockSecond`): `movedCount / persisted wall-clock interval seconds`. Skips and failures are not counted as moved opportunities. Both rates include any retry/deferred time occurring between persisted job start and completion. Neither rate is derived from `matchedCount`.

The crash-start output includes `progressImmediatelyBeforeStop`, progress after stop confirmation, and the corresponding observation timestamps. Crash-resume includes the fresh persisted restart-confirmation baseline, `restartConfirmationToObservedProgressMs`, final counters/status, and total submitted-to-completion UTC wall-clock time. Cross-process wall-clock duration may be affected by clock changes and includes operator delay. Recovery evidence is operator-attested and does not prove which OS process advanced the job. Correctness is limited to the status/counter invariants exposed by the API; no per-item audit endpoint is exposed by this harness.

HTTP status failures and transport failures are counted separately for interactive requests. Bulk submission/status failures are reported as run failures; response bodies are not emitted except for a validated short API error code. Benchmark JSON does not include database credentials or connection strings. It can include scenario metadata, workspace and job IDs, counters, workload details, and, for crash-start output, a local checkpoint path.

## Configuration

CLI values override environment variables. IDs default to the deterministic assignment seed IDs. `--target-count` is accepted only as `50000`; the harness intentionally refuses to benchmark a different target size.

| CLI option             | Environment variable           | Default                                     |
| ---------------------- | ------------------------------ | ------------------------------------------- |
| `--base-url`           | `BENCHMARK_BASE_URL`           | `http://127.0.0.1:3000`                     |
| `--large-workspace-id` | `BENCHMARK_LARGE_WORKSPACE_ID` | Seed workspace 1                            |
| `--large-stage-id`     | `BENCHMARK_LARGE_STAGE_ID`     | Seed workspace 1, stage 1                   |
| `--small-workspace-id` | `BENCHMARK_SMALL_WORKSPACE_ID` | Seed workspace 2                            |
| `--small-stage-id`     | `BENCHMARK_SMALL_STAGE_ID`     | Seed workspace 2, stage 1                   |
| `--source-stage-id`    | `BENCHMARK_SOURCE_STAGE_ID`    | Large workspace, stage 1                    |
| `--target-stage-id`    | `BENCHMARK_TARGET_STAGE_ID`    | Large workspace, stage 2                    |
| `--target-count`       | `BENCHMARK_TARGET_COUNT`       | `50000` (only accepted value)               |
| `--request-rate`       | `BENCHMARK_REQUEST_RATE`       | `2` per second per workspace                |
| `--concurrency`        | `BENCHMARK_CONCURRENCY`        | `1` per workspace                           |
| `--duration-seconds`   | `BENCHMARK_DURATION_SECONDS`   | `60`                                        |
| `--poll-interval-ms`   | `BENCHMARK_POLL_INTERVAL_MS`   | `1000`                                      |
| `--timeout-seconds`    | `BENCHMARK_TIMEOUT_SECONDS`    | `3600`                                      |
| `--output`             | `BENCHMARK_OUTPUT`             | Timestamped JSON under `benchmarks/`        |
| `--checkpoint`         | `BENCHMARK_CHECKPOINT`         | `benchmarks/crash-recovery-checkpoint.json` |

Use `npm run benchmark:bulk -- --help` for the CLI summary. Base URLs with credentials, paths, query strings, or fragments are rejected. Only the URL origin is written to results.

## Hardware and PostgreSQL record

The harness records client OS/platform, architecture, Node version, CPU model, and logical CPU count when available. PostgreSQL version and local-server status are user-confirmed. CPU/RAM utilization, PostgreSQL settings, connection usage, and separate API/database hardware utilization were not measured. The local single-machine test does not validate production deployment characteristics.

| Field                              | Recorded value                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------- |
| Benchmark client CPU / RAM         | 13th Gen Intel Core i5-1335U; 15.69 GB RAM                                      |
| API / PostgreSQL deployment        | Local single-machine run; separate resource utilization not measured            |
| PostgreSQL version / configuration | 18.6; configuration and utilization not recorded                                |
| Node.js / npm                      | v22.23.4 / 10.9.9                                                               |
| Dataset                            | 515,000 opportunities across 6 workspaces, as confirmed for this run            |
| Request rate / concurrency         | 2 requests/second/workspace; max concurrency 1/workspace                        |
| Run count                          | One baseline, one during-bulk run, and one operator-attested crash/recovery run |

## Limitations

- These are single-run local measurements; there are no repeated runs, confidence intervals, or production-environment validation.
- CPU/RAM utilization was not measured, and the harness does not record PostgreSQL configuration or execution plans.
- The configured probe rate/concurrency is low and fixed; results do not characterize higher-load behavior or all API routes.
- Client-side latency includes local scheduling and network effects; the two workspace samples share one client process and are not independent load generators.
- There is no warm-up period. Connection establishment and connection reuse can influence early and subsequent latency samples.
- The default interaction probes use the same low-rate GET workload and page size; they do not represent every API route or a production traffic mix.
- Worker and API share PostgreSQL. This harness measures observed latency but does not impose resource isolation or fairness.
- Job throughput uses persisted job counters and worker lifecycle timestamps. It does not expose per-item retry attempts or isolate database time from application time.
- Crash recovery depends on the operator ensuring there are no other worker instances able to claim the job. Process stop/restart and attribution of subsequent progress are not independently verified by the harness.
- Crash recovery is a manually coordinated experiment. The harness never kills the worker and cannot verify process termination independently.
- The harness does not query PostgreSQL directly, inspect execution plans, or verify each opportunity's final stage; final correctness checks use persisted job status and counters exposed by the API.
