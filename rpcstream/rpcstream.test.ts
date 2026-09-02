import { describe, expect, it, vi } from 'vitest'
import { pushable } from 'it-pushable'

import { RpcStream } from './rpcstream.js'
import type { RpcStreamPacket } from './rpcstream.pb.js'

describe('RpcStream lifecycle', () => {
  it('closes while its source is blocked', async () => {
    const tx = pushable<RpcStreamPacket>({ objectMode: true })
    const rx = pushable<RpcStreamPacket>({ objectMode: true })
    const stream = new RpcStream(tx, rx[Symbol.asyncIterator]())
    const pending = stream.source.next()

    await stream.close()

    await expect(pending).resolves.toEqual({ done: true, value: undefined })
    await expect(tx.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('aborts while its source is blocked', async () => {
    const tx = pushable<RpcStreamPacket>({ objectMode: true })
    const rx = pushable<RpcStreamPacket>({ objectMode: true })
    const stream = new RpcStream(tx, rx[Symbol.asyncIterator]())
    const pending = stream.source.next()
    const error = new Error('stopped')

    stream.abort(error)

    await expect(pending).rejects.toBe(error)
    await expect(tx.next()).rejects.toBe(error)
  })

  it('closes while its sink source is blocked', async () => {
    const tx = pushable<RpcStreamPacket>({ objectMode: true })
    const rx = pushable<RpcStreamPacket>({ objectMode: true })
    const input = pushable<Uint8Array>({ objectMode: true })
    const stream = new RpcStream(tx, rx[Symbol.asyncIterator]())
    const pending = stream.sink(input)

    await stream.close()

    await expect(pending).resolves.toBeUndefined()
    await expect(tx.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('aborts while its sink source is blocked', async () => {
    const tx = pushable<RpcStreamPacket>({ objectMode: true })
    const rx = pushable<RpcStreamPacket>({ objectMode: true })
    const input = pushable<Uint8Array>({ objectMode: true })
    const stream = new RpcStream(tx, rx[Symbol.asyncIterator]())
    const pending = stream.sink(input)
    const error = new Error('stopped')

    stream.abort(error)

    await expect(pending).rejects.toBe(error)
    await expect(tx.next()).rejects.toBe(error)
  })

  it('does not write input that becomes ready as the stream closes', async () => {
    const tx = pushable<RpcStreamPacket>({ objectMode: true })
    const rx = pushable<RpcStreamPacket>({ objectMode: true })
    const input = pushable<Uint8Array>({ objectMode: true })
    const stream = new RpcStream(tx, rx[Symbol.asyncIterator]())
    input.push(new Uint8Array([1]))

    const pending = stream.sink(input)
    await stream.close()

    await expect(pending).resolves.toBeUndefined()
    await expect(tx.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('does not close when its sink completes', async () => {
    const tx = pushable<RpcStreamPacket>({ objectMode: true })
    const rx = pushable<RpcStreamPacket>({ objectMode: true })
    const stream = new RpcStream(tx, rx[Symbol.asyncIterator]())
    await stream.sink((async function* () {})())
    rx.push({ body: { case: 'data', value: new Uint8Array([1]) } })

    await expect(stream.source.next()).resolves.toMatchObject({ done: false })
  })
  it('finalizes a sink input iterator when closed', async () => {
    const tx = pushable<RpcStreamPacket>({ objectMode: true })
    const rx = pushable<RpcStreamPacket>({ objectMode: true })
    const returned = vi.fn(() =>
      Promise.resolve({ done: true as const, value: undefined }),
    )
    const input = {
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<IteratorResult<Uint8Array>>(() => {}),
        return: returned,
      }),
    }
    const stream = new RpcStream(tx, rx[Symbol.asyncIterator]())
    const pending = stream.sink(input)

    await stream.close()
    await pending

    expect(returned).toHaveBeenCalledOnce()
  })

  it('cancels the outer RPC when aborted after sink completion', async () => {
    const tx = pushable<RpcStreamPacket>({ objectMode: true })
    const returned = vi.fn(() =>
      Promise.resolve({ done: true as const, value: undefined }),
    )
    const rx = {
      next: () => new Promise<IteratorResult<RpcStreamPacket>>(() => {}),
      return: returned,
    }
    const stream = new RpcStream(tx, rx)
    await stream.sink((async function* () {})())

    stream.abort(new Error('stopped'))

    expect(returned).toHaveBeenCalledOnce()
  })
})
