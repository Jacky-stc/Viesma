import type { MoveX } from '@viesma/domain'

/** 傳輸層 DTO。接收端須先驗證 payload，再轉成 simulation command。 */
export interface InputFrame {
  readonly protocolVersion: number
  readonly connectionEpoch: string
  readonly mapEpoch: number
  readonly seq: number
  readonly moveX: MoveX
  readonly jumpPressed: boolean
  readonly attackPressed: boolean
}

export interface PublicRoomHeader {
  readonly mapInstanceId: string
  readonly serverTick: number
}
