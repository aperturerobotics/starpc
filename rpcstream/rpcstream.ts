import { Observable, from as obsFrom } from 'rxjs'
import { RpcStreamPacket } from './rpcstream.pb.js'
import { Server } from '../srpc/server.js'
import { OpenStreamFunc, Stream } from '../srpc/stream.js'
import { pushable, Pushable } from 'it-pushable'
import { Source, Sink } from 'it-stream-types'

// RpcStreamCaller is the RPC client function to start a RpcStream.
export type RpcStreamCaller = (
  request: Observable<RpcStreamPacket>
) => Observable<RpcStreamPacket>

// buildRpcStreamOpenStream builds a OpenStream func with a RpcStream.
export function buildRpcStreamOpenStream(
  componentId: string,
  caller: RpcStreamCaller
): OpenStreamFunc {
  return async (): Promise<Stream> => {
    const packetSink: Pushable<RpcStreamPacket> = pushable({ objectMode: true })
    const packetObs = obsFrom(packetSink)
    const packetSource = caller(packetObs)

    // write the component id
    packetSink.push({
      body: {
        $case: 'init',
        init: { componentId },
      },
    })

    // build & return the stream
    return new RpcStream(packetSink, packetSource)
  }
}

// RpcStreamGetter looks up the Server to use for the given Component ID.
export type RpcStreamGetter = (componentId: string) => Promise<Server>

// handleRpcStream handles an incoming RPC stream (remote is the initiator).
export async function* handleRpcStream(
  stream: Observable<RpcStreamPacket>,
  getter: RpcStreamGetter
): AsyncIterable<RpcStreamPacket> {
  // read the component id
  const initPromise = new Promise<RpcStreamPacket>((resolve, reject) => {
    const subscription = stream.subscribe({
      next(value: RpcStreamPacket) {
        resolve(value)
        subscription.unsubscribe()
      },
      error(err) {
        reject(err)
      },
      complete() {
        reject(new Error('no packet received'))
      },
    })
  })

  // read the init packet
  const initRpcStreamPacket = await initPromise
  if (initRpcStreamPacket?.body?.$case !== 'init') {
    throw new Error('expected init packet')
  }

  // lookup the server for the component id.
  const server = await getter(initRpcStreamPacket.body.init.componentId)

  // build the outgoing packet sink & the packet source
  const packetSink: Pushable<RpcStreamPacket> = pushable({ objectMode: true })

  // handle the stream
  const rpcStream = new RpcStream(packetSink, stream)
  server.handleDuplex(rpcStream)

  // process packets
  for await (const packet of packetSink) {
    yield* [packet]
  }
}

// RpcStream implements the Stream on top of a RPC call.
export class RpcStream implements Stream {
  // source is the source for incoming Uint8Array packets.
  public readonly source: Source<Uint8Array>
  // sink is the sink for outgoing Uint8Array packets.
  public readonly sink: Sink<Uint8Array>

  // _packetSink writes packets to the remote.
  private readonly _packetSink: {
    push: (val: RpcStreamPacket) => void
    end: (err?: Error) => void
  }
  // _source emits incoming data to the source.
  private readonly _source: {
    push: (val: Uint8Array) => void
    end: (err?: Error) => void
  }

  constructor(
    packetSink: Pushable<RpcStreamPacket>,
    packetSource: Observable<RpcStreamPacket>
  ) {
    this._packetSink = packetSink
    this.sink = this._createSink()

    const source: Pushable<Uint8Array> = pushable({ objectMode: true })
    this.source = source
    this._source = source

    this._subscribeRpcStreamPacketSource(packetSource)
  }

  // _createSink initializes the sink field.
  private _createSink(): Sink<Uint8Array> {
    return async (source) => {
      try {
        for await (const msg of source) {
          this._packetSink.push({
            body: { $case: 'data', data: msg },
          })
        }
        this._packetSink.end()
      } catch (err) {
        this._packetSink.end(err as Error)
      }
    }
  }

  // _subscribeRpcStreamPacketSource starts the subscription to the response data.
  private _subscribeRpcStreamPacketSource(
    packetSource: Observable<RpcStreamPacket>
  ) {
    packetSource.subscribe({
      next: (value: RpcStreamPacket) => {
        if (value?.body?.$case === 'data') {
          this._source.push(value.body.data)
        }
      },
      error: (err) => {
        this._source.end(err)
      },
      complete: () => {
        this._source.end()
      },
    })
  }
}
