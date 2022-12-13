import { WebSocketConn } from '../srpc/websocket.js'
import {
  runClientTest,
  runRpcStreamTest,
  runAbortControllerTest,
} from '../echo/client-test.js'
import WebSocket from 'isomorphic-ws'

async function runRPC() {
  const addr = 'ws://localhost:5000/demo'
  console.log(`Connecting to ${addr}`)
  const ws = new WebSocket(addr)
  const channel = new WebSocketConn(ws, 'outbound')
  const client = channel.buildClient()

  console.log('Running RpcStream test via WebSocket..')
  await runRpcStreamTest(client)

  console.log('Running client test via WebSocket..')
  await runClientTest(client)

  console.log('Running abort controller test via WebSocket..')
  await runAbortControllerTest(client)
}

process.on('unhandledRejection', (ev) => {
  console.error('Unhandled rejection', ev)
  throw ev
})

runRPC()
  .then(() => {
    process.exit(0)
  })
  .catch((err) => {
    console.error('runRPC threw error', err)
    process.exit(1)
  })
