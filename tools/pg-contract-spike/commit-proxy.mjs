import { Buffer } from 'node:buffer'
import { createConnection, createServer } from 'node:net'

export async function startCommitResponseProxy(upstreamPort) {
  let dropCommit = false
  let droppedCommit = false
  const sockets = new Set()
  const server = createServer((client) => {
    const backend = createConnection({ host: '127.0.0.1', port: upstreamPort })
    sockets.add(client)
    sockets.add(backend)

    function closeBoth() {
      client.destroy()
      backend.destroy()
      sockets.delete(client)
      sockets.delete(backend)
    }

    client.once('close', closeBoth)
    backend.once('close', closeBoth)
    client.once('error', closeBoth)
    backend.once('error', closeBoth)
    client.pipe(backend)

    // PostgreSQL 非 TLS 後端訊息格式為一個 type byte、四 bytes 長度及 payload。
    let buffered = Buffer.alloc(0)
    backend.on('data', (data) => {
      buffered = Buffer.concat([buffered, data])
      while (buffered.length >= 5) {
        const messageLength = 1 + buffered.readInt32BE(1)
        if (buffered.length < messageLength) break
        const message = buffered.subarray(0, messageLength)
        buffered = buffered.subarray(messageLength)
        if (dropCommit && message[0] === 0x43 && message.toString('ascii', 5) === 'COMMIT\0') {
          droppedCommit = true
          closeBoth()
          return
        }
        client.write(message)
      }
    })
  })

  const port = await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
  return {
    port,
    arm() {
      dropCommit = true
    },
    get droppedCommit() {
      return droppedCommit
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
