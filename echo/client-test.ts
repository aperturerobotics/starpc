import { Client } from '../srpc/index.js'
import { EchoerClientImpl, EchoMsg } from './echo.pb.js'
import { pushable } from 'it-pushable'
import { buildRpcStreamOpenStream } from '../rpcstream/rpcstream.js'

export async function runClientTest(client: Client) {
  const demoServiceClient = new EchoerClientImpl(client)

  console.log('Calling Echo: unary call...')
  let result = await demoServiceClient.Echo({
    body: 'Hello world!',
  })
  console.log('success: output', result.body)

  // observable for client requests
  const clientRequestStream = pushable<EchoMsg>({ objectMode: true })
  clientRequestStream.push({ body: 'Hello world from streaming request.' })
  clientRequestStream.end()

  console.log('Calling EchoClientStream: client -> server...')
  result = await demoServiceClient.EchoClientStream(clientRequestStream)
  console.log('success: output', result.body)

  console.log('Calling EchoServerStream: server -> client...')
  const serverStream = demoServiceClient.EchoServerStream({
    body: 'Hello world from server to client streaming request.',
  })
  for await (const msg of serverStream) {
    console.log('server: output', msg.body)
  }
}

// runRpcStreamTest tests a RPCStream.
export async function runRpcStreamTest(client: Client) {
  console.log('Calling RpcStream to open a RPC stream client...')
  const service = new EchoerClientImpl(client)
  const openStreamFn = buildRpcStreamOpenStream(
    'test',
    service.RpcStream.bind(service)
  )
  const proxiedClient = new Client(openStreamFn)
  const proxiedService = new EchoerClientImpl(proxiedClient)
  console.log('Calling Echo via RPC stream...')
  const resp = await proxiedService.Echo({ body: 'hello world via proxy' })
  console.log('rpc stream test: succeeded: response: ' + resp.body)
}
