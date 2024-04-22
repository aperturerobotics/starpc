import { pushable, Pushable } from 'it-pushable'
import { Source, Sink } from 'it-stream-types'
import { RpcAck, RpcStreamPacket } from './rpcstream_pb.js'
import { OpenStreamFunc, PacketStream } from '../srpc/stream.js'
import { PartialMessage } from '@bufbuild/protobuf'

// RpcStreamCaller is the RPC client function to start a RpcStream.
export type RpcStreamCaller = (
  request: AsyncIterable<PartialMessage<RpcStreamPacket>>,
) => AsyncIterable<RpcStreamPacket>

// openRpcStream attempts to open a stream over a RPC call.
// if waitAck is set, waits for the remote to ack the stream before returning.
export async function openRpcStream(
  componentId: string,
  caller: RpcStreamCaller,
  waitAck?: boolean,
): Promise<PacketStream> {
  const packetTx = pushable<PartialMessage<RpcStreamPacket>>({
    objectMode: true,
  })
  const packetRx = caller(packetTx)

  // write the component id
  packetTx.push({
    body: {
      case: 'init',
      value: { componentId },
    },
  })

  // construct packet stream
  const packetIt = packetRx[Symbol.asyncIterator]()

  // wait for ack, if set.
  if (waitAck) {
    const ackPacketIt = await packetIt.next()
    if (ackPacketIt.done) {
      throw new Error(`rpcstream: closed before ack packet`)
    }
    const ackPacket = ackPacketIt.value
    const ackBody = ackPacket?.body
    if (!ackBody || ackBody.case !== 'ack') {
      const msgType = ackBody?.case || 'none'
      throw new Error(`rpcstream: expected ack packet but got ${msgType}`)
    }
    const errStr = ackBody.value?.error
    if (errStr) {
      throw new Error(`rpcstream: remote: ${errStr}`)
    }
  }

  // build & return the data stream
  return new RpcStream(packetTx, packetIt)
}

// buildRpcStreamOpenStream builds a OpenStream func with a RpcStream.
export function buildRpcStreamOpenStream(
  componentId: string,
  caller: RpcStreamCaller,
): OpenStreamFunc {
  return async (): Promise<PacketStream> => {
    return openRpcStream(componentId, caller)
  }
}

// RpcStreamHandler handles an incoming RPC stream.
// implemented by server.handleDuplex.
// return the result of pipe()
export type RpcStreamHandler = (stream: PacketStream) => Promise<void>

// RpcStreamGetter looks up the handler to use for the given Component ID.
// If null is returned, throws an error: "not implemented"
export type RpcStreamGetter = (
  componentId: string,
) => Promise<RpcStreamHandler | null>

// handleRpcStream handles an incoming RPC stream (remote is the initiator).
export async function* handleRpcStream(
  packetRx: AsyncIterator<RpcStreamPacket>,
  getter: RpcStreamGetter,
): AsyncIterable<PartialMessage<RpcStreamPacket>> {
  // read the component id
  const initRpcStreamIt = await packetRx.next()
  if (initRpcStreamIt.done) {
    throw new Error('closed before init received')
  }

  const initRpcStreamPacket = initRpcStreamIt.value

  // ensure we received an init packet
  if (initRpcStreamPacket?.body?.case !== 'init') {
    throw new Error('expected init packet')
  }

  // lookup the server for the component id.
  let handler: RpcStreamHandler | null = null
  let err: Error | undefined
  try {
    handler = await getter(initRpcStreamPacket.body.value.componentId)
  } catch (errAny) {
    err = errAny as Error
    if (!err) {
      err = new Error(`rpc getter failed`)
    } else if (!err.message) {
      err = new Error(`rpc getter failed: ${err}`)
    }
  }

  if (!handler && !err) {
    err = new Error('not implemented')
  }

  yield* [
    {
      body: {
        case: 'ack' as const,
        value: {
          error: err?.message || '',
        },
      },
    },
  ]

  if (err) {
    throw err
  }

  // build the outgoing packet sink & the packet source
  const packetTx: Pushable<RpcStreamPacket> = pushable({ objectMode: true })

  // start the handler
  const rpcStream = new RpcStream(packetTx, packetRx)
  handler!(rpcStream)
    .catch((err) => packetTx.end(err))
    .then(() => packetTx.end())

  // process packets
  for await (const packet of packetTx) {
    yield* [packet]
  }
}

// RpcStream implements the PacketStream on top of a RPC call.
// Note: expects the stream to already have been negotiated.
export class RpcStream implements PacketStream {
  // source is the source for incoming Uint8Array packets.
  public readonly source: AsyncGenerator<Uint8Array>
  // sink is the sink for outgoing Uint8Array packets.
  public readonly sink: Sink<Source<Uint8Array>, Promise<void>>

  // _packetRx receives packets from the remote.
  private readonly _packetRx: AsyncIterator<RpcStreamPacket>
  // _packetTx writes packets to the remote.
  private readonly _packetTx: {
    push: (val: PartialMessage<RpcStreamPacket>) => void
    end: (err?: Error) => void
  }

  // packetTx writes packets to the remote.
  // packetRx receives packets from the remote.
  constructor(
    packetTx: Pushable<PartialMessage<RpcStreamPacket>>,
    packetRx: AsyncIterator<RpcStreamPacket>,
  ) {
    this._packetTx = packetTx
    this._packetRx = packetRx
    this.sink = this._createSink()
    this.source = this._createSource()
  }

  // _createSink initializes the sink field.
  private _createSink(): Sink<Source<Uint8Array>, Promise<void>> {
    return async (source: Source<Uint8Array>) => {
      try {
        for await (const arr of source) {
          this._packetTx.push({
            body: { case: 'data', value: arr },
          })
        }
        this._packetTx.end()
      } catch (err) {
        this._packetTx.end(err as Error)
      }
    }
  }

  // _createSource initializes the source field.
  private _createSource(): AsyncGenerator<Uint8Array> {
    return (async function* (packetRx: AsyncIterator<RpcStreamPacket>) {
      while (true) {
        const msgIt = await packetRx.next()
        if (msgIt.done) {
          return
        }
        const value = msgIt.value
        const body = value?.body
        if (!body) {
          continue
        }
        switch (body.case) {
          case 'ack':
            if (body.value.error?.length) {
              throw new Error(body.value.error)
            }
            break
          case 'data':
            yield body.value
            break
        }
      }
    })(this._packetRx)
  }
}
