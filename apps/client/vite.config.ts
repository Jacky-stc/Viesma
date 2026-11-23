import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const workspaceRoot = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/')
const serverPackages = /(?:^|\/node_modules\/)(?:@colyseus\/(?:core|ws-transport)|colyseus|express|drizzle-(?:orm|kit)|pg)(?:\/|$)/
const serverWorkspacePaths = /^(?:apps\/server|packages\/persistence)(?:\/|$)/
const serverWorkspacePackages = /^@viesma\/(?:server|persistence)(?:\/|$)/

export default defineConfig({
  plugins: [
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
