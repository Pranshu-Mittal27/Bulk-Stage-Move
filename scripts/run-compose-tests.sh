#!/bin/sh

set -eu

npm ci
npm run db:generate
npm run db:check:test
npm run db:migrate:deploy
npm run db:seed:assignment -- --small --confirm-disposable-database ghl_bulk_stage_test
npm test -- --runInBand
node --experimental-vm-modules ./node_modules/jest/bin/jest.js --config ./test/jest-e2e.json --runInBand
