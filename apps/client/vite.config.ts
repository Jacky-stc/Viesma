import react from '@vitejs/plugin-react'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { viesmaAssets } from './tools/vite-assets.ts'

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/')
const serverPackages = /(?:^|\/node_modules\/)(?:@colyseus\/(?:core|ws-transport)|colyseus|express|drizzle-(?:orm|kit)|pg)(?:\/|$)/
const serverWorkspacePaths = /^(?:apps\/server|packages\/persistence)(?:\/|$)/
const serverWorkspacePackages = /^@viesma\/(?:server|persistence)(?:\/|$)/

const proxy = {
  '/multiplayer': {
    target: `http://127.0.0.1:${Number(process.env.VIESMA_SERVER_PORT ?? 2567)}`,
    ws: true,
    rewrite: (path: string) => path.slice('/multiplayer'.length),
  },
}

export default defineConfig({
  server: { proxy },
  preview: { proxy },
  plugins: [
    viesmaAssets(),
    react(),
    {
      name: 'viesma-client-bundle-boundary',
      apply: 'build',
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type !== 'chunk') continue

          const moduleIds = [...output.moduleIds, ...output.imports, ...output.dynamicImports]
          for (const id of moduleIds) {
            const normalizedId = id.replaceAll('\\', '/')
            const isServerWorkspacePath =
              normalizedId.startsWith(workspaceRoot) && serverWorkspacePaths.test(normalizedId.slice(workspaceRoot.length))
            if (
              serverPackages.test(normalizedId) ||
              isServerWorkspacePath ||
              serverWorkspacePackages.test(normalizedId) ||
              normalizedId.includes('__vite-browser-external')
            ) {
              this.error(`Server-only module in ${output.fileName}: ${id}`)
            }
          }
        }
      },
    },
  ],
})
