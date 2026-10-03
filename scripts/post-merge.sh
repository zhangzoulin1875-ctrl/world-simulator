#!/bin/bash
set -e

# Install any new dependencies brought in by the merge.
pnpm install --frozen-lockfile

# NOTE: no drizzle-kit push here on purpose.
# All schema changes in this project are applied by guarded idempotent
# migrations that run when the API server boots (discordNewsMigrations.ts,
# militaryMigrations.ts, diplomacyMigrations.ts, ...). drizzle-kit push is
# interactive (stdin is closed here, and it has offered destructive actions
# like truncating player_nations), so it must never run in post-merge.
# Workflow reconciliation restarts the API server after this script, which
# applies any new migrations automatically.
