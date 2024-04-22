import first from 'it-first'
import { EchoMsg } from './echo_pb.js'
import { Server } from '../srpc/server.js'
import { messagePushable, writeToPushable } from '../srpc/pushable.js'
import { RpcStreamPacket } from '../rpcstream/rpcstream_pb.js'
import { MessageStream } from '../srpc/message.js'
import { handleRpcStream, RpcStreamHandler } from '../rpcstream/rpcstream.js'
import { Echoer } from './echo_srpc.pb.js'
import { PartialMessage } from '@bufbuild/protobuf'

// EchoServer implements the Echoer server.
export class EchoerServer implements Echoer {
  // proxyServer is the server used for RpcStream requests.
  private proxyServer?: Server

  constructor(proxyServer?: Server) {
    this.proxyServer = proxyServer
  }

  public async echo(request: EchoMsg): Promise<PartialMessage<EchoMsg>> {
    return request
  }

  public async *echoServerStream(request: EchoMsg): MessageStream<EchoMsg> {
    for (let i = 0; i < 5; i++) {
      yield request
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  public async echoClientStream(
    request: MessageStream<EchoMsg>,
  ): Promise<PartialMessage<EchoMsg>> {
    // return the first message sent by the client.
    const message = await first(request)
    if (!message) {
      throw new Error('received no messages')
    }
    return message
  }

  public echoBidiStream(
    request: MessageStream<EchoMsg>,
  ): MessageStream<EchoMsg> {
    // build result observable
    const result = messagePushable<EchoMsg>()
    result.push({ body: 'hello from server' })
    writeToPushable(request, result)
    return result
  }

  public rpcStream(
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
