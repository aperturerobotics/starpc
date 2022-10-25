import { pipe } from 'it-pipe'
import { createHandler, createMux, Server, Client, Conn } from '../srpc'
import { EchoerDefinition, EchoerServer, runClientTest } from '../echo'
import { runRpcStreamTest } from '../echo/client-test'

async function runRPC() {
  const mux = createMux()
  const server = new Server(mux.lookupMethodFunc)
  const echoer = new EchoerServer(server)
  mux.register(createHandler(EchoerDefinition, echoer))

  const clientConn = new Conn()
  const serverConn = new Conn(server, { direction: 'inbound' })
  pipe(clientConn, serverConn, clientConn)
  const client = new Client(clientConn.buildOpenStreamFunc())

  await runRpcStreamTest(client)
  await runClientTest(client)
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
