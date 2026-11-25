import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'
import { fileURLToPath, URL } from 'node:url'

const root = fileURLToPath(new URL('../..', import.meta.url))
const nativeBin = process.env.VIESMA_SPIKE_POSTGRES_BIN
if (nativeBin && !isAbsolute(nativeBin)) throw new Error('VIESMA_SPIKE_POSTGRES_BIN must be an absolute path')
const identity = `viesma_pg_${randomBytes(8).toString('hex')}`
const password = randomBytes(24).toString('hex')
const temp = await mkdtemp(join(tmpdir(), 'viesma-pg-contract-'))
const envFile = join(temp, 'compose.env')
const pgData = join(temp, 'data')
const compose = ['compose', '--file', join(root, 'compose.yaml'), '--env-file', envFile, '--project-name', identity]
const pgEnv = { ...process.env, POSTGRES_DB: identity, POSTGRES_USER: identity, POSTGRES_PASSWORD: password, POSTGRES_PORT: '0' }
delete pgEnv.DOCKER_HOST

function run(command, args, { env = process.env, capture = false, timeout = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, windowsHide: true, stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] })
    let output = ''
    child.stdout?.setEncoding('utf8').on('data', (chunk) => (output += chunk))
    const timer = setTimeout(() => child.kill(), timeout)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('close', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) resolve(output.trim())
      else reject(new Error(`${command} ${args[0]} failed (${code ?? signal})`))
    })
  })
}

async function reservePort() {
  const server = createServer()
  const port = await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
  await new Promise((resolve) => server.close(resolve))
  return port
}

function native(command, args, options) {
  return run(join(nativeBin, command + (process.platform === 'win32' ? '.exe' : '')), args, options)
}

async function removeClusterDirectory() {
  const resolvedTemp = await realpath(temp)
  if (dirname(resolvedTemp) !== (await realpath(tmpdir()))) throw new Error('Unexpected temporary cluster location')
  await rm(resolvedTemp, { recursive: true })
}

let launchAttempted = false
try {
  let port
  if (nativeBin) {
    const passwordFile = join(temp, 'password')
    await writeFile(passwordFile, `${password}\n`, { mode: 0o600 })
    await native(
      'initdb',
      ['-D', pgData, '-U', identity, '-A', 'scram-sha-256', '--pwfile', passwordFile, '--encoding=UTF8', '--no-locale'],
      {
        timeout: 90000,
      }
    )
    await rm(passwordFile)
    port = await reservePort()
    launchAttempted = true
    await native('pg_ctl', ['-D', pgData, '-l', join(temp, 'postgres.log'), '-w', '-t', '20', '-o', `-h 127.0.0.1 -p ${port}`, 'start'])
    await native('createdb', ['-h', '127.0.0.1', '-p', String(port), '-U', identity, '-w', identity], {
      env: { ...process.env, PGPASSWORD: password },
    })
  } else {
    // 不讀取專案的 .env。Compose 資源與 host port 都是本次測試專用。
    await writeFile(envFile, '')
    const endpoint = await run('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { env: pgEnv, capture: true })
    if (!/^(npipe:\/\/\/\/\.\/pipe\/|unix:\/\/\/)/.test(endpoint)) throw new Error('Expected a local Docker endpoint')
    await run('docker', ['version', '--format', '{{.Server.Version}}'], { env: pgEnv, capture: true, timeout: 5000 })
    launchAttempted = true
    await run('docker', [...compose, 'up', '--detach', '--wait', '--wait-timeout', '90', 'postgres'], { env: pgEnv, timeout: 120000 })
    const address = await run('docker', [...compose, 'port', 'postgres', '5432'], { env: pgEnv, capture: true })
    port = /^127\.0\.0\.1:(\d+)$/.exec(address)?.[1]
    if (!port) throw new Error('Expected PostgreSQL on an isolated loopback port')
  }
  await run(
    process.execPath,
    ['node_modules/vitest/vitest.mjs', 'run', '--reporter=verbose', '--config', 'tools/pg-contract-spike/vitest.config.mjs'],
    {
      env: {
        ...process.env,
        VIESMA_SPIKE_DB_ID: identity,
        VIESMA_SPIKE_DB_PASSWORD: password,
        VIESMA_SPIKE_DB_PORT: String(port),
      },
      timeout: 120000,
    }
  )
} finally {
  if (launchAttempted) {
    if (!nativeBin) await run('docker', [...compose, 'down', '--volumes'], { env: pgEnv })
    else if (existsSync(join(pgData, 'postmaster.pid'))) await native('pg_ctl', ['-D', pgData, '-m', 'fast', '-w', '-t', '20', 'stop'])
  }
  await removeClusterDirectory()
}
