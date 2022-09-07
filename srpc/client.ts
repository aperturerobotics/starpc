import { pipe } from 'it-pipe'
import { pushable, Pushable } from 'it-pushable'

import type { TsProtoRpc } from './ts-proto-rpc.js'
import type { OpenStreamFunc } from './stream.js'
import { ClientRPC } from './client-rpc.js'
import { writeToPushable } from './pushable.js'
import {
  decodePacketSource,
  encodePacketSource,
  parseLengthPrefixTransform,
  prependLengthPrefixTransform,
} from './packet.js'
import { combineUint8ArrayListTransform } from './array-list.js'

// Client implements the ts-proto Rpc interface with the drpcproto protocol.
export class Client implements TsProtoRpc {
  // openStreamFn is a promise which contains the OpenStreamFunc.
  private openStreamFn: Promise<OpenStreamFunc>
  // _openStreamFn resolves openStreamFn.
  private _openStreamFn?: (conn?: OpenStreamFunc, err?: Error) => void

  constructor(openStreamFn?: OpenStreamFunc) {
    this.openStreamFn = this.setOpenStreamFn(openStreamFn)
  }

  // setOpenStreamFn updates the openStreamFn for the Client.
  public setOpenStreamFn(
    openStreamFn?: OpenStreamFunc
  ): Promise<OpenStreamFunc> {
    if (this._openStreamFn) {
      if (openStreamFn) {
        this._openStreamFn(openStreamFn)
        this._openStreamFn = undefined
      }
    } else {
      if (openStreamFn) {
        this.openStreamFn = Promise.resolve(openStreamFn)
      } else {
        this.initOpenStreamFn()
      }
    }
    return this.openStreamFn
  }

  // initOpenStreamFn creates the empty Promise for openStreamFn.
  private initOpenStreamFn(): Promise<OpenStreamFunc> {
    const openPromise = new Promise<OpenStreamFunc>((resolve, reject) => {
      this._openStreamFn = (conn?: OpenStreamFunc, err?: Error) => {
        if (err) {
          reject(err)
        } else if (conn) {
          resolve(conn)
        }
      }
    })
    this.openStreamFn = openPromise
    return this.openStreamFn
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
    data: AsyncIterable<Uint8Array>
  ): Promise<Uint8Array> {
    const call = await this.startRpc(service, method, null)
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
    data: Uint8Array
  ): AsyncIterable<Uint8Array> {
    const serverData: Pushable<Uint8Array> = pushable({ objectMode: true })
    this.startRpc(service, method, data)
      .then(async (call) => {
        return writeToPushable(call.rpcDataSource, serverData)
      })
      .catch(serverData.throw.bind(serverData))
    return serverData
  }

  // bidirectionalStreamingRequest starts a two-way streaming request.
  public bidirectionalStreamingRequest(
    service: string,
    method: string,
    data: AsyncIterable<Uint8Array>
  ): AsyncIterable<Uint8Array> {
    const serverData: Pushable<Uint8Array> = pushable({ objectMode: true })
    this.startRpc(service, method, null)
      .then(async (call) => {
        call.writeCallDataFromSource(data)
        try {
          for await (const message of call.rpcDataSource) {
            serverData.push(message)
          }
        } catch (err) {
          serverData.throw(err as Error)
        }
        serverData.end()
      })
      .catch(serverData.throw.bind(serverData))
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
    const openStreamFn = await this.openStreamFn
    const conn = await openStreamFn()
    const call = new ClientRPC(rpcService, rpcMethod)
    pipe(
      conn,
      parseLengthPrefixTransform(),
      combineUint8ArrayListTransform(),
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
