import { Client, ERR_RPC_ABORT } from '../srpc/index.js'
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

// runAbortControllerTest tests aborting a RPC call.
export async function runAbortControllerTest(client: Client) {
  const demoServiceClient = new EchoerClientImpl(client)

  console.log('Testing EchoClientStream with AbortController...')
  let errorReturned = false
  const clientAbort = new AbortController()
  const clientNoopStream = pushable<EchoMsg>({ objectMode: true })
  new Promise((resolve) => setTimeout(resolve, 1000)).then(() => {
    clientAbort.abort()
  })
  try {
    await demoServiceClient.EchoClientStream(
      clientNoopStream,
      clientAbort.signal
    )
  } catch (err) {
    const errMsg = (err as Error).message
    errorReturned = true
    if (errMsg !== ERR_RPC_ABORT) {
      throw new Error('unexpected error: ' + errMsg)
    }
  }
  if (!errorReturned) {
    throw new Error('expected aborted rpc to throw error')
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

  console.log('Running client test over RPC stream...')
  await runClientTest(proxiedClient)
}
