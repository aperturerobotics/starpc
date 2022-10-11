import type { Sink, Source } from 'it-stream-types'
import { pipe } from 'it-pipe'
import { pushable } from 'it-pushable'

import { Definition, MethodDefinition } from './definition.js'
import {
  buildDecodeMessageTransform,
  buildEncodeMessageTransform,
} from './message.js'
import { writeToPushable } from './pushable.js'

// InvokeFn describes an SRPC call method invoke function.
export type InvokeFn = (
  dataSource: Source<Uint8Array>,
  dataSink: Sink<Uint8Array>
) => Promise<void>

// Handler describes a SRPC call handler implementation.
export interface Handler {
  // getServiceID returns the ID of the service.
  getServiceID(): string
  // getMethodIDs returns the IDs of the methods.
  getMethodIDs(): string[]
  // lookupMethod looks up the method matching the service & method ID.
  // returns null if not found.
  lookupMethod(serviceID: string, methodID: string): Promise<InvokeFn | null>
}

// MethodMap is a map from method id to invoke function.
export type MethodMap = { [name: string]: InvokeFn }

// StaticHandler is a handler with a definition and implementation.
export class StaticHandler implements Handler {
  // service is the service id
  private service: string
  // methods is the map of method to invoke fn
  private methods: MethodMap

  constructor(serviceID: string, methods: MethodMap) {
    this.service = serviceID
    this.methods = methods
  }

  // getServiceID returns the ID of the service.
  public getServiceID(): string {
    return this.service
  }

  // getMethodIDs returns the IDs of the methods.
  public getMethodIDs(): string[] {
    return Object.keys(this.methods)
  }

  // lookupMethod looks up the method matching the service & method ID.
  // returns null if not found.
  public async lookupMethod(
    serviceID: string,
    methodID: string
  ): Promise<InvokeFn | null> {
    if (serviceID && serviceID !== this.service) {
      return null
    }
    return this.methods[methodID] || null
  }
}

// MethodProto is a function which matches one of the RPC signatures.
type MethodProto<R, O> =
  | ((request: R) => Promise<O>)
  | ((request: R) => AsyncIterable<O>)
  | ((request: AsyncIterable<R>) => Promise<O>)
  | ((request: AsyncIterable<R>) => AsyncIterable<O>)

// createInvokeFn builds an InvokeFn from a method definition and a function prototype.
export function createInvokeFn<R, O>(
  methodInfo: MethodDefinition<R, O>,
  methodProto: MethodProto<R, O>
): InvokeFn {
  const requestDecode = buildDecodeMessageTransform<R>(methodInfo.requestType)
  return async (dataSource: Source<Uint8Array>, dataSink: Sink<Uint8Array>) => {
    // responseSink is a Sink for response messages.
    const responseSink = pushable<O>({
      objectMode: true,
    })

    // pipe responseSink to dataSink.
    pipe(
      responseSink,
      buildEncodeMessageTransform(methodInfo.responseType),
      dataSink
    )

    // requestSource is a Source of decoded request messages.
    const requestSource = pipe(dataSource, requestDecode)

    // build the request argument.
    let requestArg: any
    if (methodInfo.requestStream) {
      // use the request source as the argument.
      requestArg = requestSource
    } else {
      // receive a single message for the argument.
      for await (const msg of requestSource) {
        if (msg) {
          requestArg = msg
          break
        }
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
      if (methodInfo.responseStream) {
        const response = responseObj as AsyncIterable<O>
        return writeToPushable(response, responseSink)
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
      throw asError
    }
  }
}

// createHandler creates a handler from a definition and an implementation.
// if serviceID is not set, uses the fullName of the service as the identifier.
export function createHandler(
  definition: Definition,
  impl: any,
  serviceID?: string
): Handler {
  // serviceID defaults to the full name of the service from Protobuf.
  serviceID = serviceID || definition.fullName

  // build map of method ID -> method prototype.
  const methodMap: MethodMap = {}
  for (const methodInfo of Object.values(definition.methods)) {
    const methodName = methodInfo.name
    let methodProto: MethodProto<unknown, unknown> = impl[methodName]
    if (!methodProto) {
      continue
    }
    methodProto = methodProto.bind(impl)
    methodMap[methodName] = createInvokeFn(methodInfo, methodProto)
  }

  return new StaticHandler(serviceID, methodMap)
}
