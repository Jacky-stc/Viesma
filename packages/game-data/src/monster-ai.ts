import { initialBalanceVersion } from './initial-physics.js'
import { id, integer, record } from './validation.js'

export function loadMonsterAiBalance(input: unknown) {
  const path = 'monsterAi'
  const data = record(input, path, [
    'balanceVersion',
    'targetScanTicks',
    'aggroRadius',
    'loseTargetRadius',
    'spawnLeash',
    'targetLossTicks',
    'windupTicks',
    'activeTicks',
    'recoveryTicks',
    'cooldownTicks',
    'corpseTicks',
    'respawnWaitTicks',
  ])
  const aggroRadius = integer(data.aggroRadius, `${path}.aggroRadius`, 1)
  const windupTicks = integer(data.windupTicks, `${path}.windupTicks`, 1)
  const activeTicks = integer(data.activeTicks, `${path}.activeTicks`, 1)
  const recoveryTicks = integer(data.recoveryTicks, `${path}.recoveryTicks`, 1)
  return Object.freeze({
    balanceVersion: id(data.balanceVersion, `${path}.balanceVersion`),
    targetScanTicks: integer(data.targetScanTicks, `${path}.targetScanTicks`, 1),
    aggroRadius,
    loseTargetRadius: integer(data.loseTargetRadius, `${path}.loseTargetRadius`, aggroRadius),
    spawnLeash: integer(data.spawnLeash, `${path}.spawnLeash`, 1),
    targetLossTicks: integer(data.targetLossTicks, `${path}.targetLossTicks`, 1),
    windupTicks,
    activeTicks,
    recoveryTicks,
    cooldownTicks: integer(data.cooldownTicks, `${path}.cooldownTicks`, windupTicks + activeTicks + recoveryTicks),
    corpseTicks: integer(data.corpseTicks, `${path}.corpseTicks`, 1),
    respawnWaitTicks: integer(data.respawnWaitTicks, `${path}.respawnWaitTicks`, 1),
  })
}

export const initialMonsterAiBalance = loadMonsterAiBalance({
  balanceVersion: initialBalanceVersion,
  targetScanTicks: 6,
  aggroRadius: 320,
  loseTargetRadius: 480,
  spawnLeash: 512,
  targetLossTicks: 90,
  windupTicks: 9,
  activeTicks: 1,
  recoveryTicks: 8,
  cooldownTicks: 30,
  corpseTicks: 30,
  respawnWaitTicks: 300,
})
