import { describe, expect, it } from 'vitest'
import { pushable } from 'it-pushable'

import { ChannelStream } from './channel.js'

describe('ChannelStream', () => {
  it('keeps MessagePort peer writes open after local source completes normally', async () => {
    const { port1, port2 } = new MessageChannel()
    const client = new ChannelStream<Uint8Array>('client', port1)
    const server = new ChannelStream<Uint8Array>('server', port2)
    await expectPeerWriteAfterLocalSourceCompletes(client, server)
  })

  it('keeps BroadcastChannel peer writes open after local source completes normally', async () => {
    const channelName = `channel-stream-${Date.now()}-${Math.random()}`
    const clientToServer = `${channelName}-client-to-server`
    const serverToClient = `${channelName}-server-to-client`
    const client = new ChannelStream<Uint8Array>('client', {
      tx: new BroadcastChannel(clientToServer),
      rx: new BroadcastChannel(serverToClient),
    })
    const server = new ChannelStream<Uint8Array>('server', {
      tx: new BroadcastChannel(serverToClient),
      rx: new BroadcastChannel(clientToServer),
    })
    await expectPeerWriteAfterLocalSourceCompletes(client, server)
  })

  it('propagates explicit close errors as full teardown', async () => {
    const { port1, port2 } = new MessageChannel()
    const active = new ChannelStream<Uint8Array>('active', port1)
    const passive = new ChannelStream<Uint8Array>('passive', port2)
    const next = passive.source[Symbol.asyncIterator]().next()

    try {
      active.close(new Error('boom'))

      await expect(next).rejects.toThrow('boom')
      expect((passive as any).closed).toBe(true)
      expect(port2.onmessage).toBe(null)
    } finally {
      active.close()
      passive.close()
    }
  })
})

async function expectPeerWriteAfterLocalSourceCompletes(
  client: ChannelStream<Uint8Array>,
  server: ChannelStream<Uint8Array>,
) {
  const clientWrites = pushable<Uint8Array>({ objectMode: true })
  const serverWrites = pushable<Uint8Array>({ objectMode: true })
  const clientSink = client.sink(clientWrites)
  const serverSink = server.sink(serverWrites)
  const clientReads = client.source[Symbol.asyncIterator]()
  const serverReads = server.source[Symbol.asyncIterator]()

  try {
    const request = new Uint8Array([1, 2, 3])
    clientWrites.push(request)

    await expect(readNext(serverReads)).resolves.toEqual({
      done: false,
      value: request,
    })

    clientWrites.end()
    await expect(readNext(serverReads)).resolves.toEqual({
      done: true,
      value: undefined,
    })

    const response = new Uint8Array([4, 5, 6])
    serverWrites.push(response)
    await expect(readNext(clientReads)).resolves.toEqual({
      done: false,
      value: response,
    })

    serverWrites.end()
    await expect(clientSink).resolves.toBeUndefined()
    await expect(serverSink).resolves.toBeUndefined()
    await expect(readNext(clientReads)).resolves.toEqual({
      done: true,
      value: undefined,
    })
    expect((client as any).closed).toBe(true)
    expect((server as any).closed).toBe(true)
  } finally {
    client.close()
    server.close()
  }
}

function readNext<T>(
  source: AsyncIterator<T>,
): Promise<IteratorResult<T, undefined>> {
  return Promise.race([
    source.next(),
    new Promise<IteratorResult<T, undefined>>((_, reject) => {
      setTimeout(
        () => reject(new Error('timed out waiting for stream data')),
        100,
      )
    }),
  ])
}
