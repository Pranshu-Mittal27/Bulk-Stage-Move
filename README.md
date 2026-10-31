# bulk-stage-service

An ESM-first NestJS and PostgreSQL foundation for an asynchronous bulk opportunity stage-move service. Business models and job-processing behavior are intentionally not included yet.

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

The check executes `SELECT 1`, reports configuration errors separately from connection failures, and closes the Prisma client. The Prisma schema contains no models yet; setup and connectivity checks do not run migrations or change database contents.

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
