import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // 以公開套件名稱載入 source entry，讓單元測試可在 build 前執行。
    alias: {
      '@viesma/domain': fileURLToPath(new URL('./packages/domain/src/index.ts', import.meta.url)),
      '@viesma/simulation': fileURLToPath(new URL('./packages/simulation/src/index.ts', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['{apps,packages}/*/test/**/*.test.{ts,mjs}'],
  },
})
