import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'

export const workspaceRoot = fileURLToPath(new URL('../', import.meta.url))
const shared = ['domain', 'game-data', 'physics', 'simulation', 'protocol', 'network-colyseus']
const workspaceImports = {
  'apps/client': shared,
  'apps/server': [...shared, 'persistence'],
  'packages/domain': [],
  'packages/game-data': ['domain'],
  'packages/physics': ['domain'],
  'packages/simulation': ['domain', 'game-data', 'physics'],
  'packages/protocol': ['domain'],
  'packages/network-colyseus': ['domain', 'protocol'],
  'packages/persistence': ['domain', 'game-data'],
}

const databasePackage = /^(?:drizzle-(?:orm|kit)|pg|pg-native)(?:\/|$)/
const colyseusPackage = /^(?:@colyseus\/(?:core|schema|sdk|ws-transport)|colyseus)(?:\/|$)/

export function canImport(area, specifier) {
  const allowed = workspaceImports[area]
  if (allowed === undefined) return false
  if (specifier.startsWith('@viesma/')) {
    return allowed.some((dependency) => specifier === `@viesma/${dependency}`)
  }
  if (area === 'packages/network-colyseus') return colyseusPackage.test(specifier)
  if (area === 'packages/persistence') return databasePackage.test(specifier) || specifier === '@types/pg'
  if (area === 'apps/server') return !databasePackage.test(specifier)
  if (area === 'apps/client') {
    return !databasePackage.test(specifier) && !/^(?:@colyseus\/(?:core|ws-transport)|colyseus|express)(?:\/|$)/.test(specifier)
  }
  return false
}

export const workspaceImportRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      forbidden: '{{area}} cannot import "{{specifier}}". Use a permitted workspace package public entry.',
      computed: 'Workspace imports require a literal specifier so dependency boundaries can be checked.',
    },
  },
  create(context) {
    const projectPath = relative(workspaceRoot, context.filename).replaceAll('\\', '/')
    const area = projectPath.split('/').slice(0, 2).join('/')
    const sourceRoot = resolve(workspaceRoot, area, 'src')

    function check(source) {
      if (!source) return
      if (typeof source.value !== 'string') {
        context.report({ node: source, messageId: 'computed' })
        return
      }

      const specifier = source.value.replaceAll('\\', '/')
      let permitted
      if (specifier.startsWith('./') || specifier.startsWith('../')) {
        const target = relative(sourceRoot, resolve(dirname(context.filename), specifier))
        permitted = target !== '..' && !target.startsWith('../') && !target.startsWith('..\\') && !isAbsolute(target)
      } else {
        permitted = !isAbsolute(specifier) && !specifier.startsWith('file:') && canImport(area, specifier)
      }
      if (!permitted) {
        context.report({ node: source, messageId: 'forbidden', data: { area, specifier } })
      }
    }

    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression: (node) => check(node.source),
      TSImportType: (node) => check(node.source),
      TSExternalModuleReference: (node) => check(node.expression),
    }
  },
}
