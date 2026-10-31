# bulk-stage-service

An ESM-first NestJS and PostgreSQL service foundation, with the first workspace-scoped opportunity API milestone. Bulk-job processing, workers, queues, authentication, and UI are not included.

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

Bulk-job schema is present, but submission APIs and workers are not implemented yet. Review the forward-only migration SQL before applying it, and only migrate a database confirmed to be a development target.

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

### API tests

The end-to-end suite uses unique workspace fixtures in the configured PostgreSQL database and removes only those fixtures afterward. It does not reset the database. Configure `DATABASE_URL` and apply the reviewed migrations before running:

```powershell
npm run db:migrate:deploy
npm test
npm run test:e2e
```
