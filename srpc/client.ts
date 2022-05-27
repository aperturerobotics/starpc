import { CallData, CallStart, CallStartResp, Packet } from './rpcproto'
import type { Observable } from 'rxjs'
import type { TsProtoRpc } from './ts-proto-rpc'
import type { Writer } from './writer'
import type { OpenStreamFunc } from './stream'

// DataCb is a callback to handle incoming data.
// Returns true if more data is expected, false otherwise.
// If returns undefined, assumes more data is expected.
type DataCb = (data: Uint8Array) => Promise<boolean | void>

// ClientRPC is an ongoing RPC from the client side.
export class ClientRPC {
  // conn is the RPC call connection.
  private conn: Writer
  // service is the rpc service
  private service: string
  // method is the rpc method
  private method: string
  // dataCb is called with any incoming data.
  private dataCb?: DataCb
  // started is resolved when the request starts.
  private started: Promise<void>
  // onStarted is called by the message handler when the request starts.
  private onStarted?: (err?: Error) => void
  // complete is resolved when the request completes.
  // rejected with an error if the call encountered any error.
  private complete: Promise<void>
  // onComplete is called by the message handler when the call completes.
  private onComplete?: (err?: Error) => void

  constructor(
    conn: Writer,
    service: string,
    method: string,
    dataCb: DataCb | null
  ) {
    this.conn = conn
    this.service = service
    this.method = method
    if (dataCb) {
      this.dataCb = dataCb
    }
    this.started = new Promise<void>((resolveStarted, rejectStarted) => {
      this.onStarted = (err?: Error) => {
        if (err) {
          rejectStarted(err)
        } else {
          resolveStarted()
        }
      }
    })
    this.complete = new Promise<void>((resolveComplete, rejectComplete) => {
      this.onComplete = (err?: Error) => {
        if (err) {
          rejectComplete(err)
        } else {
          resolveComplete()
        }
      }
    })
  }

  // waitStarted returns the started promise.
  public waitStarted(): Promise<void> {
    return this.started
  }

  // waitComplete returns the complete promise.
  public waitComplete(): Promise<void> {
    return this.complete
  }

  // writeCallStart writes the call start packet.
  public async writeCallStart(data: Uint8Array) {
    const callStart: CallStart = {
      rpcService: this.service,
      rpcMethod: this.method,
      data,
    }
    await this.writePacket({
      body: {
        $case: 'callStart',
        callStart,
      },
    })
  }

  // writePacket writes a packet to the stream.
  private async writePacket(packet: Packet) {
    return this.conn.writePacket(packet)
  }

  // handleMessage handles an incoming encoded Packet.
  //
  // note: may throw an error if the message was unexpected or invalid.
  public async handleMessage(message: Uint8Array) {
    return this.handlePacket(Packet.decode(message))
  }

  // handlePacket handles an incoming packet.
  public async handlePacket(packet: Partial<Packet>) {
    switch (packet?.body?.$case) {
      case 'callStart':
        return this.handleCallStart(packet.body.callStart)
      case 'callStartResp':
        return this.handleCallStartResp(packet.body.callStartResp)
      case 'callData':
        return this.handleCallData(packet.body.callData)
    }
  }

  // handleCallStart handles a CallStart packet.
  public async handleCallStart(_packet: Partial<CallStart>) {
    // we do not implement server -> client RPCs.
    throw new Error('unexpected server to client rpc start')
  }

  // handleCallStartResp handles a CallStartResp packet.
  public async handleCallStartResp(packet: Partial<CallStartResp>) {
    if (packet.error && packet.error.length) {
      const err = new Error(packet.error)
      this.onStarted!(err)
      this.onComplete!(err)
    }
  }

  // handleCallData handles a CallData packet.
  public async handleCallData(packet: Partial<CallData>) {
    const data = packet.data
    if (this.dataCb && data?.length) {
      await this.dataCb(data)
    }
    if (packet.error && packet.error.length) {
      this.onComplete!(new Error(packet.error))
    } else if (packet.complete) {
      this.onComplete!()
    }
  }

  // close closes the active call if not already completed.
  public close() {
    this.conn.close()
    this.onComplete!(new Error('call closed'))
  }
}

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
    service: string,
    method: string,
    data: Observable<Uint8Array>
  ): Promise<Uint8Array> {
    // TODO
    throw new Error('TODO clientStreamingRequest')
  }

  // serverStreamingRequest starts a server-side streaming request.
  public serverStreamingRequest(
    service: string,
    method: string,
    data: Uint8Array
  ): Observable<Uint8Array> {
    throw new Error('TODO serverStreamingRequest')
  }

  // bidirectionalStreamingRequest starts a two-way streaming request.
  public bidirectionalStreamingRequest(
    service: string,
    method: string,
    data: Observable<Uint8Array>
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
    const call = new ClientRPC(conn.getWriter(), rpcService, rpcMethod, dataCb)
    conn.setPacketHandler(call.handlePacket.bind(call))
    await call.writeCallStart(data)
    return call
  }
}
