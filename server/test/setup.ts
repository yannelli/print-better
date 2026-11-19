import { applyD1Migrations } from 'cloudflare:test'
import { env } from 'cloudflare:workers'

// Runs outside per-file storage isolation and may run more than once; already-applied migrations are skipped.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
