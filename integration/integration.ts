import { WebSocketConn } from '../srpc/websocket.js'
import { runClientTest, runRpcStreamTest } from '../echo/client-test.js'
import WebSocket from 'isomorphic-ws'

async function runRPC() {
  const addr = 'ws://localhost:5000/demo'
  console.log(`Connecting to ${addr}`)
  const ws = new WebSocket(addr)
  const channel = new WebSocketConn(ws, 'outbound')
  const client = channel.buildClient()

  console.log('Running client test via WebSocket..')
  await runClientTest(client)

  console.log('Running RpcStream test via WebSocket..')
  await runRpcStreamTest(client)
}

runRPC()
  .then(() => {
    process.exit(0)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
