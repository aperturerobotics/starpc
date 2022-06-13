import type { Observable } from 'rxjs'
import type { TsProtoRpc } from './ts-proto-rpc'
import type { OpenStreamFunc } from './stream'
import { DataCb, ClientRPC } from './client-rpc'
import { pipe } from 'it-pipe'
import {
  decodePacketSource,
  encodePacketSource,
  parseLengthPrefixTransform,
  prependLengthPrefixTransform,
} from './packet'

// Client implements the ts-proto Rpc interface with the drpcproto protocol.
export class Client implements TsProtoRpc {
  // openConnFn is the open connection function.
  // called when starting RPC.
  private openConnFn: OpenStreamFunc

  constructor(openConnFn: OpenStreamFunc) {
    this.openConnFn = openConnFn
  }

  // request starts a non-streaming request.
  public async request(
    service: string,
    method: string,
    data: Uint8Array
  ): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      const dataCb: DataCb = async (
        data: Uint8Array
      ): Promise<boolean | void> => {
        // resolve the promise
        resolve(data)
        // this is the last data we expect.
        return false
      }
      this.startRpc(service, method, data, dataCb)
        .then((call) => {
          call.waitComplete().finally(() => {
            // ensure we resolve it if no data was ever returned.
            resolve(new Uint8Array(0))
          })
        })
        .catch(reject)
    })
  }

  // clientStreamingRequest starts a client side streaming request.
  public clientStreamingRequest(
    _service: string,
    _method: string,
    _data: Observable<Uint8Array>
  ): Promise<Uint8Array> {
    // TODO
    throw new Error('TODO clientStreamingRequest')
  }

  // serverStreamingRequest starts a server-side streaming request.
  public serverStreamingRequest(
    _service: string,
    _method: string,
    _data: Uint8Array
  ): Observable<Uint8Array> {
    throw new Error('TODO serverStreamingRequest')
  }

  // bidirectionalStreamingRequest starts a two-way streaming request.
  public bidirectionalStreamingRequest(
    _service: string,
    _method: string,
    _data: Observable<Uint8Array>
  ): Observable<Uint8Array> {
    throw new Error('TODO bidirectionalStreamingRequest')
  }

  // startRpc is a common utility function to begin a rpc call.
  // returns the remote rpc id once the rpc call has begun
  // throws any error starting the rpc call
  private async startRpc(
    rpcService: string,
    rpcMethod: string,
    data: Uint8Array,
    dataCb: DataCb
  ): Promise<ClientRPC> {
    const conn = await this.openConnFn()
    const call = new ClientRPC(rpcService, rpcMethod, dataCb)
    pipe(
      conn,
      parseLengthPrefixTransform(),
      decodePacketSource,
      call,
      encodePacketSource,
      prependLengthPrefixTransform(),
      conn,
    )
    await call.writeCallStart(data)
    return call
  }
}
