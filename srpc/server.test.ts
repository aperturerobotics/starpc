import { describe, it, beforeEach } from 'vitest'
import { pipe } from 'it-pipe'
import {
  createHandler,
  createMux,
  Server,
  Client,
  StreamConn,
  ChannelStream,
  combineUint8ArrayListTransform,
  ChannelStreamOpts,
} from '../srpc/index.js'
import { EchoerDefinition, EchoerServer, runClientTest } from '../echo/index.js'
import {
  runAbortControllerTest,
  runRpcStreamTest,
} from '../echo/client-test.js'

describe('srpc server', () => {
  let client: Client

  beforeEach(async () => {
    const mux = createMux()
    const server = new Server(mux.lookupMethodFunc)
    const echoer = new EchoerServer(server)
    mux.register(createHandler(EchoerDefinition, echoer))

    // StreamConn is unnecessary since ChannelStream has packet framing.
    // Use it here to include yamux in this e2e test.
    const clientConn = new StreamConn()
    const serverConn = new StreamConn(server, { direction: 'inbound' })

    // pipe clientConn -> messageStream -> serverConn -> messageStream -> clientConn
    const { port1: clientPort, port2: serverPort } = new MessageChannel()
    const opts: ChannelStreamOpts = {} // { idleTimeoutMs: 250, keepAliveMs: 100 }
    const clientChannelStream = new ChannelStream('client', clientPort, opts)
    const serverChannelStream = new ChannelStream('server', serverPort, opts)

    // Pipe the client traffic via the client end of the MessageChannel.
    pipe(
      clientChannelStream,
      clientConn,
      combineUint8ArrayListTransform(),
      clientChannelStream,
    )
      .catch((err: Error) => clientConn.close(err))
      .then(() => clientConn.close())

    // Pipe the server traffic via the server end of the MessageChannel.
    pipe(
      serverChannelStream,
      serverConn,
      combineUint8ArrayListTransform(),
      serverChannelStream,
    )
      .catch((err: Error) => serverConn.close(err))
      .then(() => serverConn.close())

    // Build the client
    client = new Client(clientConn.buildOpenStreamFunc())
  })

  it('should pass client tests', async () => {
    await runClientTest(client)
  })

  it('should pass abort controller tests', async () => {
    await runAbortControllerTest(client)
  })

  it('should pass rpc stream tests', async () => {
    await runRpcStreamTest(client)
  })
})
