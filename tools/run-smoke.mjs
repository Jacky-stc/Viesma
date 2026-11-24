import { spawn } from 'node:child_process'
import console from 'node:console'
import process from 'node:process'
import { fileURLToPath, URL } from 'node:url'

const cli = fileURLToPath(import.meta.resolve('@playwright/test/cli'))
const cwd = fileURLToPath(new URL('..', import.meta.url))
const options = process.argv.slice(2)
if (options.some((option) => option !== '--list')) {
  throw new Error('The smoke runner accepts only --list. Use pnpm exec playwright test for custom options.')
}

const multiplayerFile = String.raw`[/\\]tests[/\\]smoke[/\\]multiplayer\.spec\.mjs$`
const outputRoot = 'node_modules/.cache/playwright'
const phases = [
  { name: 'Multiplayer', args: [multiplayerFile, '--workers=1', `--output=${outputRoot}/multiplayer`] },
  { name: 'Remaining smoke tests', args: [`^(?!.*${multiplayerFile}).*`, `--output=${outputRoot}/remaining`] },
]

let activeChild
let interrupted

function interrupt(signal) {
  if (interrupted) return
  interrupted = signal
  // Windows 的 Ctrl+C 會廣播給同一主控台。POSIX 轉送 SIGINT，讓 Playwright 完成清理。
  if (process.platform !== 'win32') activeChild?.kill('SIGINT')
}

process.on('SIGINT', interrupt)
process.on('SIGTERM', interrupt)

async function runPhase({ name, args }) {
  console.info(`\n[smoke] ${name}`)
  try {
    const child = spawn(process.execPath, [cli, 'test', ...args, ...options], { cwd, stdio: 'inherit' })
    activeChild = child
    return await new Promise((resolve) => {
      child.on('error', (error) => console.error(`[smoke] ${name}: ${error.message}`))
      // 等 Playwright 完成 web server 與瀏覽器清理，並關閉子程序。
      child.once('close', (code, signal) => {
        if (signal) console.error(`[smoke] ${name}: terminated by ${signal}`)
        resolve(code === 0)
      })
    })
  } catch (error) {
    console.error(`[smoke] ${name}:`, error)
    return false
  } finally {
    activeChild = undefined
  }
}

let failed = false
for (const phase of phases) {
  if (interrupted) break
  if (!(await runPhase(phase))) failed = true
}

process.exitCode = interrupted ? (interrupted === 'SIGINT' ? 130 : 143) : Number(failed)
