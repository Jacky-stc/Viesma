import { defineConfig } from 'vitest/config'
import workspace from '../../vitest.config.mjs'

export default defineConfig({
  ...workspace,
  test: { ...workspace.test, include: ['tools/pg-contract-spike/*.test.mjs'], testTimeout: 15000 },
})
