import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: { alias: { '@contracts': resolve(__dirname, 'contracts') } },
  test: { include: ['tests/**/*.test.ts', 'src/**/*.test.ts', 'tools/**/*.test.ts'] }
})
