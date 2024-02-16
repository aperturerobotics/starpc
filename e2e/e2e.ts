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
} from '../srpc'
import { EchoerDefinition, EchoerServer, runClientTest } from '../echo'
import { runAbortControllerTest, runRpcStreamTest } from '../echo/client-test'

async function runRPC() {
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
  const client = new Client(clientConn.buildOpenStreamFunc())

  // Run the tests
  await runClientTest(client)
  await runAbortControllerTest(client)
  await runRpcStreamTest(client)

  // Make sure we have no uncaught promises
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 500)
  })

  // Close cleanly
  clientConn.close()
  serverConn.close()
}

runRPC()
  .then(() => {
    console.log('finished successfully')
    process.exit(0)
  })
  .catch((err) => {
    console.error('e2e tests failed', err)
    process.exit(1)
  })
