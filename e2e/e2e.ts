import { pipe } from 'it-pipe'
import { createHandler, createMux, Server, Client, StreamConn } from '../srpc'
import { EchoerDefinition, EchoerServer, runClientTest } from '../echo'
import { runAbortControllerTest, runRpcStreamTest } from '../echo/client-test'

async function runRPC() {
  const mux = createMux()
  const server = new Server(mux.lookupMethodFunc)
  const echoer = new EchoerServer(server)
  mux.register(createHandler(EchoerDefinition, echoer))

  const clientConn = new StreamConn()
  const serverConn = new StreamConn(server, { direction: 'inbound' })

  pipe(clientConn, serverConn, clientConn)

  const client = new Client(clientConn.buildOpenStreamFunc())

  await runClientTest(client)
  await runAbortControllerTest(client)
  await runRpcStreamTest(client)
}

runRPC()
  .then(() => {
    console.log('finished successfully')
    process.exit(0)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
