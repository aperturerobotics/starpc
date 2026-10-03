import { describe, expect, it } from 'vitest'

import { ClientRPC } from './client-rpc.js'
import { isClosedBeforeCompletionError, TransportError } from './errors.js'
import { ErrorCode, Packet } from './rpcproto.pb.js'

describe('ClientRPC', () => {
  it('fails a call whose transport ends before the remote completes it', async () => {
    const call = new ClientRPC('svc', 'method')
    await call.sink(packetSource(callDataPacket(new Uint8Array([1]))))

    const received = new Array<number>()
    const read = async () => {
      for await (const data of call.rpcDataSource) {
        received.push(data[0])
      }
    }
    const err = await read().then(
      () => undefined,
      (err: unknown) => err,
    )

    expect(received).toEqual([1])
    expect(isClosedBeforeCompletionError(err)).toBe(true)
    expect(isClosedBeforeCompletionError(call.isClosed)).toBe(true)
  })

  it.each([ErrorCode.RESET, ErrorCode.CLOSED_BEFORE_COMPLETION])(
    'preserves forwarded transport code %s and its diagnostic',
    async (code) => {
      const call = new ClientRPC('svc', 'method')
      await call.sink(
        packetSource(
          Packet.create({
            body: {
              case: 'callData',
              value: {
                error: 'original diagnostic',
                errorCode: code,
                complete: true,
              },
            },
          }),
        ),
      )

      const read = async () => {
        for await (const _ of call.rpcDataSource) {
          throw new Error('unexpected payload')
        }
      }
      const err = await read().catch((error: unknown) => error)
      expect(err).toBeInstanceOf(TransportError)
      expect((err as TransportError).code).toBe(code)
      expect((err as TransportError).message).toBe('original diagnostic')
      expect(isClosedBeforeCompletionError(err)).toBe(
        code === ErrorCode.CLOSED_BEFORE_COMPLETION,
      )
    },
  )

  it('ends a call cleanly when the remote completes it before the transport ends', async () => {
    const call = new ClientRPC('svc', 'method')
    await call.sink(
      packetSource(
        callDataPacket(new Uint8Array([1])),
        callDataPacket(undefined, true),
      ),
    )

    const received = new Array<number>()
    for await (const data of call.rpcDataSource) {
      received.push(data[0])
    }

    expect(received).toEqual([1])
    expect(call.isClosed).toBe(false)
  })
})

// callDataPacket builds an incoming call-data packet.
function callDataPacket(data?: Uint8Array, complete = false): Packet {
  return Packet.create({
    body: {
      case: 'callData',
      value: {
        data: data ?? new Uint8Array(0),
        dataIsZero: false,
        complete,
        error: '',
      },
    },
  })
}

// packetSource yields packets and then ends like a closed transport.
async function* packetSource(...packets: Packet[]): AsyncGenerator<Packet> {
  for (const packet of packets) {
    yield packet
  }
}
