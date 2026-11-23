export {}

declare global {
  // Colyseus 的 HTTP 宣告使用 HeadersInit。從 Node 的 Headers 建構子取得相同型別。
  type HeadersInit = NonNullable<ConstructorParameters<typeof Headers>[0]>
}
