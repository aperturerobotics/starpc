import { Client, ERR_RPC_ABORT } from '../srpc/index.js'
import { EchoMsg } from './echo.pb.js'
import { EchoerClient } from './echo_srpc.pb.js'
import { pushable } from 'it-pushable'
import {
  buildRpcStreamOpenStream,
  openRpcStream,
} from '../rpcstream/rpcstream.js'
import { Message } from '@aptre/protobuf-es-lite'

export async function runClientTest(client: Client) {
  const demoServiceClient = new EchoerClient(client)

  console.log('Calling Echo: unary call...')
  let result = await demoServiceClient.Echo({
    body: 'Hello world!',
  })
  console.log('success: output', result.body)

  console.log('Calling Echo: unary call with empty request/response...')
  await demoServiceClient.DoNothing({
    body: 'Hello world!',
  })
  console.log('success')

  // observable for client requests
  const clientRequestStream = pushable<Message<EchoMsg>>({
    objectMode: true,
  })
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
  const demoServiceClient = new EchoerClient(client)

  console.log('Testing EchoClientStream with AbortController...')
  let errorReturned = false

  const testRpc = async (rpc: (signal: AbortSignal) => Promise<void>) => {
    const clientAbort = new AbortController()
    new Promise((resolve) => setTimeout(resolve, 1000)).then(() => {
      clientAbort.abort()
    })
    try {
      await rpc(clientAbort.signal)
    } catch (err) {
      const errMsg = (err as Error).message
      errorReturned = true
      if (errMsg !== ERR_RPC_ABORT) {
        throw new Error('unexpected error: ' + errMsg, { cause: err })
      }
    }
    if (!errorReturned) {
      throw new Error('expected aborted rpc to throw error')
    }
  }

  await testRpc(async (signal) => {
    const clientNoopStream = pushable<EchoMsg>({ objectMode: true })
    await demoServiceClient.EchoClientStream(clientNoopStream, signal)
  })

  await testRpc(async (signal) => {
    const stream = demoServiceClient.EchoServerStream({ body: 'test' }, signal)
    const msgs = []
    try {
      for await (const msg of stream) {
        msgs.push(msg)
      }
    } catch (err) {
      if (msgs.length < 3) {
        throw new Error('expected at least three messages before error', {
          cause: err,
        })
      }
      throw err
    }
  })
}

function requireError(
  error: unknown,
  label: string,
  fragments: string[],
): void {
  const message = error instanceof Error ? error.message : String(error)
  if (!fragments.some((fragment) => message.includes(fragment))) {
    throw new Error(`${label} returned unexpected error: ${message}`)
  }
}

// runRpcStreamTest tests a RPCStream.
export async function runRpcStreamTest(client: Client, release = false) {
  console.log('Calling RpcStream to open a RPC stream client...')
  const service = new EchoerClient(client)
  const openStreamFn = buildRpcStreamOpenStream(
    'test',
    service.RpcStream.bind(service),
  )
  const proxiedClient = new Client(openStreamFn)
  const proxiedService = new EchoerClient(proxiedClient)

  console.log('Calling Echo via RPC stream...')
  const resp = await proxiedService.Echo({ body: 'hello world via proxy' })
  console.log('rpc stream test: succeeded: response: ' + resp.body)

  console.log('Running client test over RPC stream...')
  await runClientTest(proxiedClient)

  if (release) {
    let unknownRejected = false
    try {
      await openRpcStream('missing', service.RpcStream.bind(service), true)
    } catch (error) {
      unknownRejected = true
      requireError(error, 'unknown component', ['unknown component: missing'])
    }
    if (!unknownRejected) {
      throw new Error('unknown component unexpectedly succeeded')
    }
  }

  let methodRejected = false
  try {
    await proxiedClient.request('missing.Service', 'Missing', new Uint8Array())
  } catch (error) {
    methodRejected = true
    requireError(error, 'unknown nested method', [
      'missing.Service',
      'unimplemented',
    ])
  }
  if (!methodRejected) {
    throw new Error('unknown nested method unexpectedly succeeded')
  }

  if (release) {
    const terminalService = new EchoerClient(proxiedClient)
    let terminalFailed = false
    try {
      await terminalService.Echo({ body: '__nested_error__' })
    } catch (error) {
      terminalFailed = true
      requireError(error, 'terminal nested error', ['nested terminal error'])
    }
    if (!terminalFailed) {
      throw new Error('terminal nested error unexpectedly succeeded')
    }
  }

  if (release) {
    const releaseClient = new Client(
      buildRpcStreamOpenStream('release', service.RpcStream.bind(service)),
    )
    let releaseFailed = false
    const releaseService = new EchoerClient(releaseClient)
    try {
      await releaseService.Echo({ body: '__nested_release__' })
    } catch (error) {
      releaseFailed = true
      requireError(error, 'release during active call', [
        'closed before completion',
        'stream closed',
        'abort',
        'cancel',
      ])
    }
    if (!releaseFailed) {
      throw new Error('release during active call unexpectedly succeeded')
    }
    const releaseStatus = await service.Echo({
      body: '__nested_release_status__',
    })
    if (releaseStatus.body !== 'released') {
      throw new Error(`release completion returned ${releaseStatus.body}`)
    }
    let releasedRejected = false
    try {
      await releaseService.Echo({})
    } catch (error) {
      releasedRejected = true
      requireError(error, 'released component', ['unknown component: release'])
    }
    if (!releasedRejected) {
      throw new Error('released component unexpectedly remained available')
    }
  }

  const cancelled = new AbortController()
  const cancelledStream = proxiedClient.bidirectionalStreamingRequest(
    'echo.Echoer',
    'EchoBidiStream',
    (async function* () {
      yield new Uint8Array()
      await new Promise(() => undefined)
    })(),
    cancelled.signal,
  )
  const cancelledIterator = cancelledStream[Symbol.asyncIterator]()
  const firstNestedResponse = await cancelledIterator.next()
  if (firstNestedResponse.done) {
    throw new Error('nested cancellation call ended before its first response')
  }
  cancelled.abort()
  let cancelRejected = false
  try {
    while (!(await cancelledIterator.next()).done) {
      // Drain until the abort reaches the nested call.
    }
  } catch (error) {
    cancelRejected = true
    requireError(error, 'nested cancellation', [ERR_RPC_ABORT])
  }
  if (!cancelRejected) {
    throw new Error('nested cancellation unexpectedly completed normally')
  }
}
