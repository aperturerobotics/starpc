import { pipe } from 'it-pipe'
import { pushable, Pushable } from 'it-pushable'

import { ERR_RPC_ABORT } from './errors.js'
import type { TsProtoRpc } from './ts-proto-rpc.js'
import type { OpenStreamFunc } from './stream.js'
import { ClientRPC } from './client-rpc.js'
import { writeToPushable } from './pushable.js'
import { decodePacketSource, encodePacketSource } from './packet.js'
import { OpenStreamCtr } from './open-stream-ctr.js'

// Client implements the ts-proto Rpc interface with the drpcproto protocol.
export class Client implements TsProtoRpc {
  // openStreamCtr contains the OpenStreamFunc.
  private openStreamCtr: OpenStreamCtr

  constructor(openStreamFn?: OpenStreamFunc) {
    this.openStreamCtr = new OpenStreamCtr(openStreamFn || undefined)
  }

  // setOpenStreamFn updates the openStreamFn for the Client.
  public setOpenStreamFn(openStreamFn?: OpenStreamFunc) {
    this.openStreamCtr.set(openStreamFn || undefined)
  }

  // request starts a non-streaming request.
  public async request(
    service: string,
    method: string,
    data: Uint8Array,
    abortSignal?: AbortSignal,
  ): Promise<Uint8Array> {
    const call = await this.startRpc(service, method, data, abortSignal)
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
    data: AsyncIterable<Uint8Array>,
    abortSignal?: AbortSignal,
  ): Promise<Uint8Array> {
    const call = await this.startRpc(service, method, null, abortSignal)
    call.writeCallDataFromSource(data)
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
    data: Uint8Array,
    abortSignal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    const serverData: Pushable<Uint8Array> = pushable({ objectMode: true })
    this.startRpc(service, method, data, abortSignal)
      .then(async (call) => {
        return writeToPushable(call.rpcDataSource, serverData)
      })
      .catch((err) => serverData.end(err))
    return serverData
  }

  // bidirectionalStreamingRequest starts a two-way streaming request.
  public bidirectionalStreamingRequest(
    service: string,
    method: string,
    data: AsyncIterable<Uint8Array>,
    abortSignal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    const serverData: Pushable<Uint8Array> = pushable({ objectMode: true })
    this.startRpc(service, method, null, abortSignal)
      .then(async (call) => {
        call.writeCallDataFromSource(data)
        try {
          for await (const message of call.rpcDataSource) {
            serverData.push(message)
          }
          serverData.end()
        } catch (err) {
          serverData.end(err as Error)
        }
      })
      .catch((err) => serverData.end(err))
    return serverData
  }

  // startRpc is a common utility function to begin a rpc call.
  // throws any error starting the rpc call
  // if data == null and data.length == 0, sends a separate data packet.
  private async startRpc(
    rpcService: string,
    rpcMethod: string,
    data: Uint8Array | null,
    abortSignal?: AbortSignal,
  ): Promise<ClientRPC> {
    if (abortSignal?.aborted) {
      throw new Error(ERR_RPC_ABORT)
    }
    const openStreamFn = await this.openStreamCtr.wait()
    const stream = await openStreamFn()
    const call = new ClientRPC(rpcService, rpcMethod)
    abortSignal?.addEventListener('abort', () => {
      call.close(new Error(ERR_RPC_ABORT))
    })
    pipe(stream, decodePacketSource, call, encodePacketSource, stream)
    await call.writeCallStart(data || undefined)
    return call
  }
}
