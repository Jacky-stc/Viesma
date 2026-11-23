import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { canImport, workspaceRoot } from './workspace-boundaries.mjs'

const manifests = new Map()
for (const group of ['apps', 'packages']) {
  for (const entry of readdirSync(join(workspaceRoot, group), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const area = `${group}/${entry.name}`
    const manifestPath = join(workspaceRoot, area, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (manifest.name !== `@viesma/${entry.name}` || manifests.has(manifest.name)) {
      throw new Error(`Unexpected or duplicate workspace package name in ${area}`)
    }
    const dependencies = new Map()
    for (const key of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [name, version] of Object.entries(manifest[key] ?? {})) {
        dependencies.set(name, version)
      }
    }
    manifests.set(manifest.name, { area, dependencies })
  }
}

const visited = new Set()
const visiting = new Set()

function visit(name) {
  if (visiting.has(name)) {
    const path = [...visiting]
    const cycle = path.slice(path.indexOf(name))
    throw new Error(`Workspace dependency cycle: ${[...cycle, name].join(' -> ')}`)
  }
  if (visited.has(name)) return

  visiting.add(name)
  for (const dependency of manifests.get(name).dependencies.keys()) {
    if (manifests.has(dependency)) visit(dependency)
  }
  visiting.delete(name)
  visited.add(name)
}

for (const [name, { area, dependencies }] of manifests) {
  visit(name)
  for (const [dependency, version] of dependencies) {
    if (!canImport(area, dependency)) throw new Error(`${area} cannot declare ${dependency}`)
    if (dependency.startsWith('@viesma/') && (!manifests.has(dependency) || !version.startsWith('workspace:'))) {
      throw new Error(`${area} must link ${dependency} through the workspace`)
    }
  }
}

process.stdout.write(`Verified the dependency boundaries and acyclic graph of ${manifests.size} workspace packages.\n`)
