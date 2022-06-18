import { WebSocketConn } from '../srpc'
import { runClientTest } from '../echo'
import WebSocket from 'isomorphic-ws'

async function runRPC() {
  const addr = 'ws://localhost:5000/demo'
  console.log(`Connecting to ${addr}`)
  const ws = new WebSocket(addr)
  const channel = new WebSocketConn(ws)
  const client = channel.buildClient()

  await runClientTest(client)
}

runRPC()
  .then(() => {
    process.exit(0)
  })
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
