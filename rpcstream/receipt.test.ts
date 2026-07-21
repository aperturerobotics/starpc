/// <reference lib="es2024.promise" />

import { describe, expect, it } from 'vitest'

import { Client } from '../srpc/client.js'
import { Server } from '../srpc/server.js'
import { TerminalKind } from '../srpc/rpcproto.pb.js'
import type { RpcStreamCaller } from './rpcstream.js'
import { buildRpcStreamOpenStream, handleRpcStream } from './rpcstream.js'

const response = new Uint8Array([4, 5, 6])

// This guard mirrors the Go rpcstream/receipt_test.go nested tunnel: an
// ExecCallReceipt-equivalent held unary call runs through a real handleRpcStream
// tunnel. The inner generated handler sends its single response, then the
// wrapping invocation synchronously holds on waitTerminal. The first response
// must be client-visible while the exact invocation stays open for commit.
describe('rpcstream held receipt tunnel', () => {
  it('delivers the first inner response while the invocation stays held', async () => {
    const terminal = Promise.withResolvers<TerminalKind>()

    const innerServer = new Server(async () => {
      return async (_source, dataSink, invocation) => {
        await dataSink(
          (async function* () {
            yield response
            if (!invocation) {
              throw new Error('missing invocation')
            }
            terminal.resolve(
              await invocation.waitTerminal(new AbortController().signal),
            )
          })(),
        )
      }
    })

    const caller: RpcStreamCaller = (packetTx) =>
      handleRpcStream(
        packetTx[Symbol.asyncIterator](),
        async () => innerServer.rpcStreamHandler,
      )

    const client = new Client(buildRpcStreamOpenStream('component-a', caller))

    const held = await client.requestWithReceipt(
      'test.Service',
      'Unary',
      response,
    )

    // The first inner response is client-visible while the invocation is held.
    expect(held.response).toEqual(response)

    // The inner invocation must still be open: no terminal observed yet.
    const raced = await Promise.race([
      terminal.promise.then(() => 'terminal' as const),
      Promise.resolve('pending' as const),
    ])
    expect(raced).toBe('pending')

    await expect(held.receipt.commit()).resolves.toBeUndefined()
    await expect(terminal.promise).resolves.toBe(TerminalKind.COMMITTED)
  })
})
