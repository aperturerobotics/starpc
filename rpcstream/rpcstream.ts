import { RpcStreamPacket } from './rpcstream.pb.js'
import { OpenStreamFunc, Stream } from '../srpc/stream.js'
import { pushable, Pushable } from 'it-pushable'
import { Source, Sink } from 'it-stream-types'
import { Uint8ArrayList } from 'uint8arraylist'

// RpcStreamCaller is the RPC client function to start a RpcStream.
export type RpcStreamCaller = (
  request: AsyncIterable<RpcStreamPacket>
) => AsyncIterable<RpcStreamPacket>

// openRpcStream attempts to open a stream over a RPC call.
// waits for the remote to ack the stream before returning.
export async function openRpcStream(
  componentId: string,
  caller: RpcStreamCaller
): Promise<Stream> {
  const packetSink: Pushable<RpcStreamPacket> = pushable({ objectMode: true })
  const packetSource = caller(packetSink)

  // write the component id
  packetSink.push({
    body: {
      $case: 'init',
      init: { componentId },
    },
  })

  // wait for ack
  const packetIt = packetSource[Symbol.asyncIterator]()
  const ackPacketIt = await packetIt.next()
  if (ackPacketIt.done) {
    throw new Error(`rpcstream: closed before ack packet`)
  }
  const ackPacket = ackPacketIt.value
  const ackBody = ackPacket?.body
  if (!ackBody || ackBody.$case !== 'ack') {
    const msgType = ackBody?.$case || 'none'
    throw new Error(`rpcstream: expected ack packet but got ${msgType}`)
  }
  const errStr = ackBody.ack?.error
  if (errStr) {
    throw new Error(`rpcstream: remote: ${errStr}`)
  }

  // build & return the data stream
  return new RpcStream(packetSink, packetIt) // packetSource)
}

// buildRpcStreamOpenStream builds a OpenStream func with a RpcStream.
export function buildRpcStreamOpenStream(
  componentId: string,
  caller: RpcStreamCaller
): OpenStreamFunc {
  return async (): Promise<Stream> => {
    return openRpcStream(componentId, caller)
  }
}

// RpcStreamHandler handles an incoming RPC stream.
// implemented by server.handleDuplex.
export type RpcStreamHandler = (stream: Stream) => void

// RpcStreamGetter looks up the handler to use for the given Component ID.
// If null is returned, throws an error: "not implemented"
export type RpcStreamGetter = (
  componentId: string
) => Promise<RpcStreamHandler | null>

// handleRpcStream handles an incoming RPC stream (remote is the initiator).
export async function* handleRpcStream(
  packetStream: AsyncIterator<RpcStreamPacket>,
  getter: RpcStreamGetter
): AsyncIterable<RpcStreamPacket> {
  // read the component id
  const initRpcStreamIt = await packetStream.next()
  if (initRpcStreamIt.done) {
    throw new Error('closed before init received')
  }

  const initRpcStreamPacket = initRpcStreamIt.value

  // ensure we received an init packet
  if (initRpcStreamPacket?.body?.$case !== 'init') {
    throw new Error('expected init packet')
  }

  // lookup the server for the component id.
  let handler: RpcStreamHandler | null = null
  let err: Error | undefined
  try {
    handler = await getter(initRpcStreamPacket.body.init.componentId)
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
    <RpcStreamPacket>{
      body: {
        $case: 'ack',
        ack: {
          error: err?.message || '',
        },
      },
    },
  ]

  if (err) {
    throw err
  }

  // build the outgoing packet sink & the packet source
  const packetSink: Pushable<RpcStreamPacket> = pushable({ objectMode: true })

  // handle the stream in the next event queue tick.
  const rpcStream = new RpcStream(packetSink, packetStream)
  setTimeout(() => {
    handler!(rpcStream)
  }, 1)

  // process packets
  for await (const packet of packetSink) {
    yield* [packet]
  }
}

// RpcStream implements the Stream on top of a RPC call.
// Note: expects the stream to already have been negotiated.
export class RpcStream implements Stream {
  // source is the source for incoming Uint8Array packets.
  public readonly source: Source<Uint8Array>
  // sink is the sink for outgoing Uint8Array packets.
  public readonly sink: Sink<Uint8ArrayList | Uint8Array>

  // _packetStream receives packets from the remote.
  private readonly _packetStream: AsyncIterator<RpcStreamPacket>
  // _packetSink writes packets to the remote.
  private readonly _packetSink: {
    push: (val: RpcStreamPacket) => void
    end: (err?: Error) => void
  }

  // packetSink writes packets to the remote.
  // packetSource receives packets from the remote.
  constructor(
    packetSink: Pushable<RpcStreamPacket>,
    packetStream: AsyncIterator<RpcStreamPacket>
  ) {
    this._packetSink = packetSink
    this._packetStream = packetStream
    this.sink = this._createSink()
    this.source = this._createSource()
  }

  // _createSink initializes the sink field.
  private _createSink(): Sink<Uint8ArrayList | Uint8Array> {
    return async (source) => {
      try {
        for await (const arr of source) {
          if (arr instanceof Uint8Array) {
            this._packetSink.push({
              body: { $case: 'data', data: arr },
            })
          } else {
            for (const msg of arr) {
              this._packetSink.push({
                body: { $case: 'data', data: msg },
              })
            }
          }
        }
        this._packetSink.end()
      } catch (err) {
        this._packetSink.end(err as Error)
      }
    }
  }

  // _createSource initializes the source field.
  private _createSource(): Source<Uint8Array> {
    const packetSource = this._packetStream
    return (async function* packetDataSource(): AsyncIterable<Uint8Array> {
      while (true) {
        const msgIt = await packetSource.next()
        if (msgIt.done) {
          return
        }
        const value = msgIt.value
        const body = value?.body
        if (!body || body.$case !== 'data') {
          continue
        }
        yield* [body.data]
      }
    })()
  }
}
