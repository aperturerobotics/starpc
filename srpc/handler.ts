import type { Sink, Source } from 'it-stream-types'
import { MethodKind, type MessageType } from '@aptre/protobuf-es-lite'
import type { MessageStream } from './message.js'
import {
  type MethodDefinition,
  ServiceDefinition,
  ServiceMethodDefinitions,
} from './definition.js'
import { createInvokeFn } from './invoker.js'
import type { ServerContext } from './server-context.js'

type MessageOf<T> = T extends MessageType<infer M> ? M : never

type ServerMethod<T> =
  T extends MethodDefinition<
    infer Request,
    infer Response,
    infer Kind,
    infer _Idempotency
  >
    ? Kind extends MethodKind.Unary
      ? (
          request: MessageOf<Request>,
          abortSignal: AbortSignal,
          context: ServerContext,
        ) => Promise<MessageOf<Response>>
      : Kind extends MethodKind.ServerStreaming
        ? (
            request: MessageOf<Request>,
            abortSignal: AbortSignal,
            context: ServerContext,
          ) => MessageStream<MessageOf<Response>>
        : Kind extends MethodKind.ClientStreaming
          ? (
              request: MessageStream<MessageOf<Request>>,
              abortSignal: AbortSignal,
              context: ServerContext,
            ) => Promise<MessageOf<Response>>
          : (
              request: MessageStream<MessageOf<Request>>,
              abortSignal: AbortSignal,
              context: ServerContext,
            ) => MessageStream<MessageOf<Response>>
    : never

export type HandlerImplementation<T extends ServiceMethodDefinitions> =
  Partial<{
    [Method in keyof T]: ServerMethod<T[Method]>
  }>

// InvokeFn describes an SRPC call method invoke function.
export type InvokeFn = (
  dataSource: Source<Uint8Array>,
  dataSink: Sink<Source<Uint8Array>>,
  context: ServerContext,
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
    methodID: string,
  ): Promise<InvokeFn | null> {
    if (serviceID && serviceID !== this.service) {
      return null
    }
    return this.methods[methodID] || null
  }
}

// createHandler creates a handler from a definition and an implementation.
// if serviceID is not set, uses the fullName of the service as the identifier.
export function createHandler<
  T extends ServiceMethodDefinitions = ServiceMethodDefinitions,
>(
  definition: ServiceDefinition<T>,
  impl: HandlerImplementation<T>,
  serviceID?: string,
): Handler {
  // serviceID defaults to the full name of the service from Protobuf.
  serviceID = serviceID || definition.typeName

  // build map of method ID -> method prototype.
  const methodMap: MethodMap = {}
  for (const methodInfo of Object.values(definition.methods)) {
    const methodName = methodInfo.name
    let methodProto = impl[methodName as keyof T] as any
    if (!methodProto) {
      continue
    }
    methodProto = methodProto.bind(impl)
    methodMap[methodName] = createInvokeFn(methodInfo, methodProto)
  }

  return new StaticHandler(serviceID, methodMap)
}
