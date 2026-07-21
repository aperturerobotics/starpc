/// <reference lib="es2024.promise" />

import { describe, expect, it } from 'vitest'
import { pushable } from 'it-pushable'
import { EchoMsg } from '../echo/echo.pb.js'
import type { Echoer } from '../echo/echo_srpc.pb.js'

import { Client } from './client.js'
import { ClientRPC } from './client-rpc.js'
import { Server } from './server.js'
import { CallReceipt } from './call-receipt.js'
import { Packet } from './rpcproto.pb.js'
import { ServerRPC } from './server-rpc.js'
import { ServerInvocation, type TerminalKind } from './server-invocation.js'

const response = new Uint8Array([1, 2, 3])

describe('generated service compatibility', () => {
  it('accepts plain abort signals and terminal-capable handlers', async () => {
    const server: Pick<Echoer, 'Echo'> = {
      Echo: async (request, invocation?: ServerInvocation) => {
        void invocation
        return request
      },
    }
    const request = EchoMsg.create({ body: 'compatibility' })
    const signal = new AbortController().signal
    await expect(server.Echo(request, signal)).resolves.toEqual(request)
  })
})

describe('held unary receipt', () => {
  it('waits for a server completion acknowledgment', async () => {
    const sent: Packet[] = []
    const terminal = Promise.withResolvers<void>()
    const client = new Client(async () => ({
      source: responseSource(terminal.promise),
      sink: async (source) => {
        for await (const data of source) {
          const packet = Packet.fromBinary(data)
          sent.push(packet)
          if (packet.body?.case === 'callData' && packet.body.value.complete) {
            terminal.resolve()
          }
        }
      },
    }))

    const held = await client.requestWithReceipt(
      'test.Service',
      'Unary',
      response,
    )
    const commit = held.receipt.commit()
    expect(held.receipt.settled).toBe(true)
    await expect(commit).resolves.toBeUndefined()

    const terminalPackets = sent.filter((packet) => {
      const body = packet.body
      return (
        body?.case === 'callCancel' ||
        (body?.case === 'callData' && body.value.complete)
      )
    })
    expect(terminalPackets).toHaveLength(1)
    expect(terminalPackets[0]?.body?.case).toBe('callData')
    await expect(held.receipt.done).resolves.toBeUndefined()
  })

  it('commits through a real TypeScript server', async () => {
    const terminal = Promise.withResolvers<string>()
    const server = new Server(async () => {
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
    const client = new Client(async () => {
      const clientToServer = pushable<Uint8Array>({ objectMode: true })
      const serverToClient = pushable<Uint8Array>({ objectMode: true })
      server.handlePacketStream({
        source: clientToServer,
        sink: async (source) => {
          for await (const packet of source) {
            serverToClient.push(packet)
          }
          serverToClient.end()
        },
      })
      return {
        source: serverToClient,
        sink: async (source) => {
          for await (const packet of source) {
            clientToServer.push(packet)
          }
          clientToServer.end()
        },
      }
    })

    const held = await client.requestWithReceipt(
      'test.Service',
      'Unary',
      response,
    )
    await expect(held.receipt.commit()).resolves.toBeUndefined()
    await expect(terminal.promise).resolves.toBe('committed')
  })

  it('rejects commit after a bare remote close', async () => {
    const call = new ClientRPC('test.Service', 'Unary')
    const iterator = call.rpcDataSource[Symbol.asyncIterator]()
    await call.handleCallData({
      data: response,
      dataIsZero: false,
      complete: false,
      error: '',
    })
    const first = await iterator.next()
    expect(first.done).toBe(false)
    const receipt = new CallReceipt(call, iterator)
    await call.close()
    await expect(receipt.commit()).rejects.toThrow()
    await expect(receipt.done).rejects.toThrow('receipt closed before commit')
  })

  it('aborts a held receipt with one cancel packet', async () => {
    const sent: Packet[] = []
    const terminal = Promise.withResolvers<void>()
    const cancelSeen = Promise.withResolvers<void>()
    const client = new Client(async () => ({
      source: responseSource(terminal.promise),
      sink: async (source) => {
        for await (const data of source) {
          const packet = Packet.fromBinary(data)
          sent.push(packet)
          if (packet.body?.case === 'callCancel') {
            cancelSeen.resolve()
          }
        }
      },
    }))

    const held = await client.requestWithReceipt(
      'test.Service',
      'Unary',
      response,
    )
    await held.receipt.abort()
    await cancelSeen.promise
    const terminalPackets = sent.filter(
      (packet) => packet.body?.case === 'callCancel',
    )
    expect(terminalPackets).toHaveLength(1)
    await expect(held.receipt.done).rejects.toThrow()
  })

  it('allows exactly one concurrent commit or abort terminal', async () => {
    const sent: Packet[] = []
    const terminal = Promise.withResolvers<void>()
    const client = new Client(async () => ({
      source: responseSource(terminal.promise),
      sink: async (source) => {
        for await (const data of source) {
          const packet = Packet.fromBinary(data)
          sent.push(packet)
          if (packet.body?.case === 'callData' && packet.body.value.complete) {
            terminal.resolve()
          }
        }
      },
    }))

    const held = await client.requestWithReceipt(
      'test.Service',
      'Unary',
      response,
    )
    const results = await Promise.allSettled([
      held.receipt.commit(),
      held.receipt.abort(),
    ])
    const terminalPackets = sent.filter((packet) => {
      const body = packet.body
      return (
        body?.case === 'callCancel' ||
        (body?.case === 'callData' && body.value.complete)
      )
    })
    expect(terminalPackets).toHaveLength(1)
    expect(results).toHaveLength(2)
  })

  it('rejects a trailing response datum instead of committing', async () => {
    const terminal = Promise.withResolvers<void>()
    const client = new Client(async () => ({
      source: (async function* () {
        yield Packet.toBinary({
          body: {
            case: 'callData',
            value: {
              data: response,
              dataIsZero: false,
              complete: false,
              error: '',
            },
          },
        })
        await terminal.promise
        yield Packet.toBinary({
          body: {
            case: 'callData',
            value: {
              data: new Uint8Array([9]),
              dataIsZero: false,
              complete: false,
              error: '',
            },
          },
        })
      })(),
      sink: async (source) => {
        for await (const data of source) {
          const packet = Packet.fromBinary(data)
          if (packet.body?.case === 'callData' && packet.body.value.complete) {
            terminal.resolve()
          }
        }
      },
    }))

    const held = await client.requestWithReceipt(
      'test.Service',
      'Unary',
      response,
    )
    await expect(held.receipt.commit()).rejects.toThrow(
      'unexpected trailing response data',
    )
  })

  it('rejects done on a remote terminal error', async () => {
    const client = new Client(async () => ({
      source: (async function* () {
        yield Packet.toBinary({
          body: {
            case: 'callData',
            value: {
              data: response,
              dataIsZero: false,
              complete: false,
              error: '',
            },
          },
        })
        yield Packet.toBinary({
          body: {
            case: 'callData',
            value: {
              data: new Uint8Array(),
              dataIsZero: false,
              complete: true,
              error: 'remote failure',
            },
          },
        })
      })(),
      sink: async (source) => {
        for await (const _data of source) {
          void _data
        }
      },
    }))

    const held = await client.requestWithReceipt(
      'test.Service',
      'Unary',
      response,
    )
    await expect(held.receipt.done).rejects.toThrow('remote failure')
  })
})

describe('server invocation terminal', () => {
  it.each([
    ['explicit completion', 'committed'],
    ['cancel', 'canceled'],
    ['transport loss', 'transportLost'],
    ['remote error packet', 'transportLost'],
    ['bare close', 'closed'],
    ['remote error packet with completion', 'transportLost'],
  ] as const)('%s is classified distinctly', async (_name, expected) => {
    const captured = Promise.withResolvers<ServerInvocation>()
    const owner = new AbortController()
    const observed = Promise.withResolvers<TerminalKind>()
    const rpc = new ServerRPC(async () => {
      return async (_source, _sink, invocation) => {
        if (!invocation) {
          throw new Error('missing invocation')
        }
        captured.resolve(invocation)
        observed.resolve(await invocation.waitTerminal(owner.signal))
      }
    })
    await rpc.handleCallStart({
      rpcService: 'test.Service',
      rpcMethod: 'Unary',
      data: new Uint8Array(),
      dataIsZero: true,
    })
    const invocation = await captured.promise
    if (expected === 'committed') {
      await rpc.handleCallData({ complete: true })
    } else if (expected === 'canceled') {
      await rpc.handleCallCancel()
    } else if (expected === 'transportLost') {
      if (
        _name === 'remote error packet' ||
        _name === 'remote error packet with completion'
      ) {
        await rpc.handleCallData({
          complete: _name === 'remote error packet with completion',
          error: 'remote failure',
        })
      } else {
        await rpc.close(new Error('transport loss'))
      }
    } else {
      await rpc.close()
    }
    await expect(observed.promise).resolves.toBe(expected)
    owner.abort()
    if (_name === 'remote error packet with completion') {
      const rpcState: object = rpc
      if (!('remoteCompleted' in rpcState)) {
        throw new Error('remote completion discriminator is missing')
      }
      expect(rpcState.remoteCompleted).toBe(false)
    }
    if (expected === 'closed' || expected === 'transportLost') {
      expect(invocation.signal.aborted).toBe(true)
    }
  })

  it.each(['transport loss', 'cancel'] as const)(
    'keeps completion after %s',
    async (followUp) => {
      const captured = Promise.withResolvers<ServerInvocation>()
      const owner = new AbortController()
      const rpc = new ServerRPC(async () => {
        return async (_source, _sink, invocation) => {
          if (!invocation) {
            throw new Error('missing invocation')
          }
          captured.resolve(invocation)
          await invocation.waitTerminal(owner.signal)
        }
      })
      await rpc.handleCallStart({
        rpcService: 'test.Service',
        rpcMethod: 'Unary',
        data: new Uint8Array(),
        dataIsZero: true,
      })
      const invocation = await captured.promise
      await rpc.handleCallData({ complete: true })
      if (followUp === 'transport loss') {
        await rpc.close(new Error('transport loss'))
      } else {
        await rpc.handleCallCancel()
      }
      await expect(invocation.waitTerminal(owner.signal)).resolves.toBe(
        'committed',
      )
      owner.abort()
    },
  )

  it('returns abandoned only for owner cancellation without a remote terminal', async () => {
    const captured = Promise.withResolvers<ServerInvocation>()
    const owner = new AbortController()
    const rpc = new ServerRPC(async () => {
      return async (_source, _sink, invocation) => {
        if (!invocation) {
          throw new Error('missing invocation')
        }
        captured.resolve(invocation)
        await invocation.waitTerminal(owner.signal)
      }
    })
    await rpc.handleCallStart({
      rpcService: 'test.Service',
      rpcMethod: 'Unary',
      data: new Uint8Array(),
      dataIsZero: true,
    })
    const invocation = await captured.promise
    owner.abort()
    await expect(invocation.waitTerminal(owner.signal)).resolves.toBe(
      'abandoned',
    )
  })
})

async function* responseSource(terminal: Promise<void>) {
  yield Packet.toBinary({
    body: {
      case: 'callData',
      value: {
        data: response,
        dataIsZero: false,
        complete: false,
        error: '',
      },
    },
  })
  await terminal
  yield Packet.toBinary({
    body: {
      case: 'callData',
      value: {
        data: new Uint8Array(),
        dataIsZero: false,
        complete: true,
        error: '',
      },
    },
  })
}
