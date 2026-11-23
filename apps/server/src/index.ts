import { Server } from '@colyseus/core'
import { WebSocketTransport } from '@colyseus/ws-transport'

const host = '127.0.0.1'
const port = 2567

const server = new Server({ transport: new WebSocketTransport(), greet: false })
await server.listen(port, host)

console.info(`Viesma server listening at http://${host}:${port}`)
