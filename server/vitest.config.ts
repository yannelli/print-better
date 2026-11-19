import path from 'node:path'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

const alias = {
  '@': path.resolve(import.meta.dirname, './src'),
  '@shared': path.resolve(import.meta.dirname, './shared'),
}

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: './wrangler.jsonc' },
            remoteBindings: false,
            miniflare: {
              bindings: {
                SETUP_TOKEN: 'test-setup-token',
                APP_SECRET: 'test-app-secret-0123456789abcdef0123456789abcdef',
                AUTH_PEPPER: 'test-pepper-0123456789abcdef',
                TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'migrations')),
              },
              // Tests stub globalThis.fetch per case; anything unstubbed must never reach the network.
              outboundService: (req: Request) => new Response(`Unmocked outbound fetch: ${req.method} ${req.url}`, { status: 599 }),
            },
          })),
        ],
        // Logins run production-cost scrypt (~0.1-0.3 s each); 5 s flakes on loaded machines.
        test: { name: 'worker', include: ['test/**/*.test.ts'], setupFiles: ['./test/setup.ts'], testTimeout: 30_000 },
      },
      {
        resolve: { alias },
        test: { name: 'web', environment: 'node', include: ['src/**/*.test.ts'] },
      },
    ],
  },
})
