import { Echoer, EchoMsg } from './echo.pb.js'
import { pushable, Pushable } from 'it-pushable'
import first from 'it-first'
import { Server } from '../srpc/server.js'
import { writeToPushable } from '../srpc/pushable.js'
import { RpcStreamPacket } from '../rpcstream/rpcstream.pb.js'
import { handleRpcStream } from '../rpcstream/rpcstream.js'

// EchoServer implements the Echoer server.
export class EchoerServer implements Echoer {
  // proxyServer is the server used for RpcStream requests.
  private proxyServer?: Server

  constructor(proxyServer?: Server) {
    this.proxyServer = proxyServer
  }

  public async Echo(request: EchoMsg): Promise<EchoMsg> {
    return request
  }

  public async *EchoServerStream(request: EchoMsg): AsyncIterable<EchoMsg> {
    for (let i = 0; i < 5; i++) {
      yield request
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  public async EchoClientStream(
    request: AsyncIterable<EchoMsg>
  ): Promise<EchoMsg> {
    // return the first message sent by the client.
    const message = await first(request)
    if (!message) {
      throw new Error('received no messages')
    }
    return message
  }

  public EchoBidiStream(
    request: AsyncIterable<EchoMsg>
  ): AsyncIterable<EchoMsg> {
    // build result observable
    const result: Pushable<EchoMsg> = pushable({ objectMode: true })
    result.push({ body: 'hello from server' })
    writeToPushable(request, result)
    return result
  }

  public RpcStream(
    request: AsyncIterable<RpcStreamPacket>
  ): AsyncIterable<RpcStreamPacket> {
    return handleRpcStream(
      request[Symbol.asyncIterator](),
      async (_componentId: string): Promise<Server> => {
        if (!this.proxyServer) {
          throw new Error('rpc stream proxy server not set')
        }
        return this.proxyServer
      }
    )
  }
}
