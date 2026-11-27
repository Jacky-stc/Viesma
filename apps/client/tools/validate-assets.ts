import process from 'node:process'
import { loadProjectAssets } from './asset-project.ts'

try {
  const { catalog, files } = loadProjectAssets(false, true)
  process.stdout.write(
    JSON.stringify(
      {
        schemaVersion: catalog.schemaVersion,
        sprites: catalog.atlases.reduce((total, atlas) => total + atlas.sprites.length, 0),
        experimentalParallax: catalog.experimentalParallax?.length,
        outputs: [...files].map(([path, bytes]) => ({ path, bytes: bytes.length })),
      },
      null,
      2
    ) + '\n'
  )
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n')
  process.exitCode = 1
}
