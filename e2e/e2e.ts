import { pipe } from 'it-pipe'
import { createHandler, createMux, Server, Client, Conn } from '../srpc'
import { EchoerDefinition, EchoerServer, runClientTest } from '../echo'

async function runRPC() {
  const mux = createMux()
  const echoer = new EchoerServer()
  mux.register(createHandler(EchoerDefinition, echoer))
  const server = new Server(mux)

  const clientConn = new Conn()
  const serverConn = new Conn(server)
  pipe(clientConn, serverConn, clientConn)
  const client = new Client(clientConn.buildOpenStreamFunc())

  await runClientTest(client)
}

runRPC()
  .then(() => {
    console.log('finished successfully')
  })
  .catch((err) => {
    console.log('failed')
    console.error(err)
    process.exit(1)
  })
