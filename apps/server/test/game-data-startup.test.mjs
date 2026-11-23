import { expect, test, vi } from 'vitest'

const { Server, WebSocketTransport } = vi.hoisted(() => ({
  Server: vi.fn(),
  WebSocketTransport: vi.fn(),
}))

vi.mock('@colyseus/core', () => ({ Server }))
vi.mock('@colyseus/ws-transport', () => ({ WebSocketTransport }))
vi.mock('@viesma/game-data', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    loadGrayboxGameData() {
      return actual.loadGrayboxGameData([])
    },
  }
})

test('rejects malformed shipped game data before constructing the transport or server', async () => {
  await expect(import('../src/index.ts')).rejects.toMatchObject({
    name: 'GameDataValidationError',
    code: 'MISSING_FIELD',
    path: 'tiledMaps',
  })
  expect(WebSocketTransport).not.toHaveBeenCalled()
  expect(Server).not.toHaveBeenCalled()
})
