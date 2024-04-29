import first from 'it-first'
import { Message } from '@aptre/protobuf-es-lite'
import { EchoMsg } from './echo.pb.js'
import { Server } from '../srpc/server.js'
import { messagePushable, writeToPushable } from '../srpc/pushable.js'
import { RpcStreamPacket } from '../rpcstream/rpcstream.pb.js'
import { MessageStream } from '../srpc/message.js'
import { handleRpcStream, RpcStreamHandler } from '../rpcstream/rpcstream.js'
import { Echoer } from './echo_srpc.pb.js'

// EchoServer implements the Echoer server.
export class EchoerServer implements Echoer {
  // proxyServer is the server used for RpcStream requests.
  private proxyServer?: Server

  constructor(proxyServer?: Server) {
    this.proxyServer = proxyServer
  }

  public async Echo(request: EchoMsg): Promise<Message<EchoMsg>> {
    return request
  }

  public async *EchoServerStream(request: EchoMsg): MessageStream<EchoMsg> {
    for (let i = 0; i < 5; i++) {
      yield request
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  public async EchoClientStream(
    request: MessageStream<EchoMsg>,
  ): Promise<Message<EchoMsg>> {
    // return the first message sent by the client.
    const message = await first(request)
    if (!message) {
      throw new Error('received no messages')
    }
    return message
  }

  public EchoBidiStream(
    request: MessageStream<EchoMsg>,
  ): MessageStream<EchoMsg> {
    // build result observable
    const result = messagePushable<EchoMsg>()
    result.push({ body: 'hello from server' })
    writeToPushable(request, result)
    return result
  }

  public RpcStream(
    request: MessageStream<RpcStreamPacket>,
  ): MessageStream<RpcStreamPacket> {
    return handleRpcStream(
      request[Symbol.asyncIterator](),
      async (): Promise<RpcStreamHandler> => {
        if (!this.proxyServer) {
          throw new Error('rpc stream proxy server not set')
        }
        return this.proxyServer.rpcStreamHandler
      },
    )
  }
}
