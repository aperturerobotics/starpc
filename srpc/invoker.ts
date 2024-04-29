import { Sink, Source } from 'it-stream-types'
import { pushable } from 'it-pushable'
import { pipe } from 'it-pipe'
import type { MethodDefinition } from './definition.js'
import { InvokeFn } from './handler.js'
import {
  buildDecodeMessageTransform,
  buildEncodeMessageTransform,
} from './message.js'
import { writeToPushable } from './pushable.js'
import type { MessageType, Message } from '@aptre/protobuf-es-lite'
import { MethodIdempotency, MethodKind } from '@aptre/protobuf-es-lite'

// MethodProto is a function which matches one of the RPC signatures.
export type MethodProto<R extends Message<R>, O extends Message<O>> =
  | ((request: R) => Promise<O>)
  | ((request: R) => AsyncIterable<O>)
  | ((request: AsyncIterable<R>) => Promise<O>)
  | ((request: AsyncIterable<R>) => AsyncIterable<O>)

// createInvokeFn builds an InvokeFn from a method definition and a function prototype.
export function createInvokeFn<R extends Message<R>, O extends Message<O>>(
  methodInfo: MethodDefinition<
    MessageType<R>,
    MessageType<O>,
    MethodKind,
    MethodIdempotency | undefined
  >,
  methodProto: MethodProto<R, O>,
): InvokeFn {
  const requestDecode = buildDecodeMessageTransform<R>(methodInfo.I)
  return async (
    dataSource: Source<Uint8Array>,
    dataSink: Sink<Source<Uint8Array>>,
  ) => {
    // responseSink is a Sink for response messages.
    const responseSink = pushable<O>({
      objectMode: true,
    })

    // pipe responseSink to dataSink.
    pipe(responseSink, buildEncodeMessageTransform(methodInfo.O), dataSink)

    // requestSource is a Source of decoded request messages.
    const requestSource = pipe(dataSource, requestDecode)

    // build the request argument.
    let requestArg: any
    if (
      methodInfo.kind === MethodKind.ClientStreaming ||
      methodInfo.kind === MethodKind.BiDiStreaming
    ) {
      // use the request source as the argument.
      requestArg = requestSource
    } else {
      // receive a single message for the argument.
      for await (const msg of requestSource) {
        requestArg = msg
        break
      }
    }

    if (!requestArg) {
      throw new Error('request object was empty')
    }

    // Call the implementation.
    try {
      const responseObj = methodProto(requestArg)
      if (!responseObj) {
        throw new Error('return value was undefined')
      }
      if (
        methodInfo.kind === MethodKind.ServerStreaming ||
        methodInfo.kind === MethodKind.BiDiStreaming
      ) {
        const response = responseObj as AsyncIterable<O>
        return writeToPushable(response as AsyncIterable<O>, responseSink)
      } else {
        const responsePromise = responseObj as Promise<O>
        if (!responsePromise.then) {
          throw new Error('expected return value to be a Promise')
        }
        const responseMsg = await responsePromise
        if (!responseMsg) {
          throw new Error('expected non-empty response object')
        }
        responseSink.push(responseMsg)
        responseSink.end()
      }
    } catch (err) {
      let asError = err as Error
      if (!asError?.message) {
        asError = new Error('error calling implementation: ' + err)
      }
      // mux will return the error to the rpc caller.
      responseSink.end()
      throw asError
    }
  }
}
