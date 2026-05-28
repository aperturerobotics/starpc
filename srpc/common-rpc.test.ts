import { describe, expect, it } from 'vitest'

import { Client } from './client.js'
import { CommonRPC } from './common-rpc.js'
import { Packet } from './rpcproto.pb.js'

describe('CommonRPC', () => {
  it('backpressures call-data sources until outbound packets drain', async () => {
    const rpc = new CommonRPC()
    const yielded = { count: 0 }
    const secondYield = deferred()
    const thirdYield = deferred()

    const writeDone = rpc.writeCallDataFromSource(
      chunkSource(
        yielded,
        new Map([
          [1, secondYield],
          [2, thirdYield],
        ]),
      ),
    )

    await promiseWithTimeout(secondYield.promise, 'second call-data chunk')
    expect(yielded.count).toBe(2)
    await expectPending(thirdYield.promise, 'third call-data chunk')
    expect(yielded.count).toBe(2)

    const received = new Array<number>()
    const readComplete = (async () => {
      for await (const packet of rpc.source) {
        const body = packet.body
        if (body?.case !== 'callData') {
          continue
        }
        if (body.value.complete) {
          return
        }
        if (!body.value.data) {
          throw new Error('call data packet missing data')
        }
        received.push(body.value.data[0])
      }
      throw new Error('outbound call data ended before completion')
    })()

    await promiseWithTimeout(
      Promise.all([writeDone, readComplete]),
      'backpressured call data drain',
    )
    await rpc.close()

    expect(yielded.count).toBe(32)
    expect(received).toHaveLength(32)
    expect(received[0]).toBe(0)
    expect(received[31]).toBe(31)
  })

  it('wakes call-data writers when the rpc closes while waiting for drain', async () => {
    const rpc = new CommonRPC()
    const yielded = { count: 0 }
    const secondYield = deferred()
    const thirdYield = deferred()

    const writeDone = rpc.writeCallDataFromSource(
      chunkSource(
        yielded,
        new Map([
          [1, secondYield],
          [2, thirdYield],
        ]),
      ),
    )

    await promiseWithTimeout(secondYield.promise, 'second call-data chunk')
    expect(yielded.count).toBe(2)
    await expectPending(thirdYield.promise, 'third call-data chunk')
    expect(yielded.count).toBe(2)

    await rpc.close()
    await expect(
      promiseWithTimeout(writeDone, 'call data writer close'),
    ).resolves.toBeUndefined()
    expect(yielded.count).toBeLessThan(32)
  })

  it('wakes call-data writers when an error closes the rpc while waiting for drain', async () => {
    const rpc = new CommonRPC()
    const yielded = { count: 0 }
    const secondYield = deferred()
    const thirdYield = deferred()

    const writeDone = rpc.writeCallDataFromSource(
      chunkSource(
        yielded,
        new Map([
          [1, secondYield],
          [2, thirdYield],
        ]),
      ),
    )

    await promiseWithTimeout(secondYield.promise, 'second call-data chunk')
    expect(yielded.count).toBe(2)
    await expectPending(thirdYield.promise, 'third call-data chunk')
    expect(yielded.count).toBe(2)

    await rpc.close(new Error('boom'))
    await expect(
      promiseWithTimeout(writeDone, 'call data writer error close'),
    ).resolves.toBeUndefined()
    expect(yielded.count).toBeLessThan(32)
  })

  it('does not backpressure call-cancel packets behind queued call data', async () => {
    const rpc = new CommonRPC()
    const yielded = { count: 0 }
    const secondYield = deferred()
    const thirdYield = deferred()
    const writeDone = rpc.writeCallDataFromSource(
      chunkSource(
        yielded,
        new Map([
          [1, secondYield],
          [2, thirdYield],
        ]),
      ),
    )

    await promiseWithTimeout(secondYield.promise, 'second call-data chunk')
    expect(yielded.count).toBe(2)
    await expectPending(thirdYield.promise, 'third call-data chunk')
    expect(yielded.count).toBe(2)

    const cancelDone = rpc.writeCallCancel()
    await rpc.close(new Error('abort'))

    await expect(
      promiseWithTimeout(cancelDone, 'call cancel write'),
    ).resolves.toBeUndefined()
    await expect(
      promiseWithTimeout(writeDone, 'blocked call data close'),
    ).resolves.toBeUndefined()
  })

  it('backpressures client-stream sources through the Client request path', async () => {
    const yielded = { count: 0 }
    const firstYield = deferred()
    const secondYield = deferred()
    const sinkConsumed = { count: 0 }
    const sinkGate = deferred()
    const responseGate = deferred()
    const response = new Uint8Array([7])
    const client = new Client(async () => ({
      source: (async function* () {
        await responseGate.promise
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
      })(),
      sink: async (source) => {
        await sinkGate.promise
        for await (const _packet of source) {
          sinkConsumed.count++
        }
      },
    }))

    const request = client.clientStreamingRequest(
      'test.Service',
      'Upload',
      chunkSource(
        yielded,
        new Map([
          [0, firstYield],
          [1, secondYield],
        ]),
      ),
    )

    await promiseWithTimeout(firstYield.promise, 'first upload chunk')
    expect(yielded.count).toBe(1)
    await expectPending(secondYield.promise, 'second upload chunk')
    expect(yielded.count).toBe(1)
    expect(sinkConsumed.count).toBe(0)
    await expectPending(request, 'client-stream request')

    sinkGate.resolve()
    responseGate.resolve()
    await expect(
      promiseWithTimeout(request, 'client-stream response'),
    ).resolves.toEqual(response)
  })
})

async function* chunkSource(
  yielded: { count: number },
  yieldMarks?: Map<number, Deferred>,
) {
  for (const i of Array.from({ length: 32 }, (_, index) => index)) {
    yielded.count++
    yieldMarks?.get(i)?.resolve()
    yield new Uint8Array([i])
  }
}

function promiseWithTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 500)
    }),
  ])
}

async function expectPending<T>(promise: Promise<T>, label: string) {
  await expect(
    Promise.race([
      promise.then(() => 'settled'),
      new Promise<'pending'>((resolve) => {
        setTimeout(() => resolve('pending'), 50)
      }),
    ]),
    `${label} should not be requested while outbound packets are blocked`,
  ).resolves.toBe('pending')
}

type Deferred = ReturnType<typeof deferred>

function deferred() {
  const callbacks: {
    resolve?: () => void
    reject?: (reason?: unknown) => void
  } = {}
  const promise = new Promise<void>((resolve, reject) => {
    callbacks.resolve = resolve
    callbacks.reject = reject
  })
  return {
    promise,
    resolve() {
      callbacks.resolve?.()
    },
    reject(reason?: unknown) {
      callbacks.reject?.(reason)
    },
  }
}
