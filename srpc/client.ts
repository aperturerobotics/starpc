import { pipe } from 'it-pipe'
import { pushable, Pushable } from 'it-pushable'
import { Observable, from as observableFrom } from 'rxjs'

import type { TsProtoRpc } from './ts-proto-rpc.js'
import type { OpenStreamFunc } from './stream.js'
import { ClientRPC } from './client-rpc.js'
import {
  decodePacketSource,
  encodePacketSource,
  parseLengthPrefixTransform,
  prependLengthPrefixTransform,
} from './packet.js'

// writeClientStream registers the subscriber to write the client data stream.
function writeClientStream(call: ClientRPC, data: Observable<Uint8Array>) {
  data.subscribe({
    next(value) {
      call.writeCallData(value)
    },
    error(err) {
      call.close(err)
    },
    complete() {
      call.writeCallData(undefined, true)
    },
  })
}

// Client implements the ts-proto Rpc interface with the drpcproto protocol.
export class Client implements TsProtoRpc {
  // openConnFn is the open connection function.
  // called when starting RPC.
  private openConnFn: OpenStreamFunc

  constructor(openConnFn: OpenStreamFunc) {
    this.openConnFn = openConnFn
  }

  // setOpenConnFn updates the openConnFn for the Client.
  public setOpenConnFn(openConnFn: OpenStreamFunc) {
    this.openConnFn = openConnFn
  }

  // request starts a non-streaming request.
  public async request(
    service: string,
    method: string,
    data: Uint8Array
  ): Promise<Uint8Array> {
    const call = await this.startRpc(service, method, data)
    for await (const data of call.rpcDataSource) {
      call.close()
      return data
    }
    const err = new Error('empty response')
    call.close(err)
    throw err
  }

  // clientStreamingRequest starts a client side streaming request.
  public async clientStreamingRequest(
    service: string,
    method: string,
    data: Observable<Uint8Array>
  ): Promise<Uint8Array> {
    const call = await this.startRpc(service, method, null)
    writeClientStream(call, data)
    for await (const data of call.rpcDataSource) {
      call.close()
      return data
    }
    const err = new Error('empty response')
    call.close(err)
    throw err
  }

  // serverStreamingRequest starts a server-side streaming request.
  public serverStreamingRequest(
    service: string,
    method: string,
    data: Uint8Array
  ): Observable<Uint8Array> {
    const pushServerData: Pushable<Uint8Array> = pushable()
    const serverData = observableFrom(pushServerData)
    this.startRpc(service, method, data)
      .then(async (call) => {
        try {
          for await (const data of call.rpcDataSource) {
            pushServerData.push(data)
          }
        } catch (err) {
          pushServerData.throw(err as Error)
        }
        pushServerData.end()
      })
      .catch(pushServerData.throw.bind(pushServerData))
    return serverData
  }

  // bidirectionalStreamingRequest starts a two-way streaming request.
  public bidirectionalStreamingRequest(
    service: string,
    method: string,
    data: Observable<Uint8Array>
  ): Observable<Uint8Array> {
    const pushServerData: Pushable<Uint8Array> = pushable()
    const serverData = observableFrom(pushServerData)
    this.startRpc(service, method, null)
      .then(async (call) => {
        try {
          data.subscribe({
            next(value) {
              call.writeCallData(value)
            },
            error(err) {
              call.close(err)
            },
            complete() {
              call.close()
            },
          })
          for await (const data of call.rpcDataSource) {
            pushServerData.push(data)
          }
        } catch (err) {
          pushServerData.throw(err as Error)
        }
        pushServerData.end()
      })
      .catch(pushServerData.throw.bind(pushServerData))
    return serverData
  }

  // startRpc is a common utility function to begin a rpc call.
  // throws any error starting the rpc call
  // if data == null and data.length == 0, sends a separate data packet.
  private async startRpc(
    rpcService: string,
    rpcMethod: string,
    data: Uint8Array | null
  ): Promise<ClientRPC> {
    const conn = await this.openConnFn()
    const call = new ClientRPC(rpcService, rpcMethod)
    pipe(
      conn,
      parseLengthPrefixTransform(),
      decodePacketSource,
      call,
      encodePacketSource,
      prependLengthPrefixTransform(),
      conn
    )
    await call.writeCallStart(data || undefined)
    return call
  }
}
