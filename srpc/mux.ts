import { InvokeFn, Handler } from './handler'

// Mux contains a set of <service, method> handlers.
export interface Mux {
  // register registers a new RPC method handler.
  register(handler: Handler): void
  // lookupMethod looks up the method matching the service & method ID.
  // returns null if not found.
  lookupMethod(serviceID: string, methodID: string): Promise<InvokeFn | null>
}

// createMux builds a new Mux.
export function createMux(): Mux {
  return new StaticMux()
}

// staticMuxMethods is a mapping from method id to handler.
type staticMuxMethods = { [methodID: string]: Handler }

// StaticMux contains a in-memory mapping between service ID and handlers.
// implements Mux
export class StaticMux implements Mux {
  // services contains a mapping from service id to handlers.
  private services: { [id: string]: staticMuxMethods } = {}

  public register(handler: Handler): void {
    const serviceID = handler?.getServiceID()
    if (!serviceID) {
      throw new Error('service id cannot be empty')
    }
    const serviceMethods = this.services[serviceID] || {}
    const methodIDs = handler.getMethodIDs()
    for (const methodID of methodIDs) {
      serviceMethods[methodID] = handler
    }
    this.services[serviceID] = serviceMethods
  }

  public async lookupMethod(
    serviceID: string,
    methodID: string
  ): Promise<InvokeFn | null> {
    if (!serviceID) {
      return null
    }
    const serviceMethods = this.services[serviceID]
    if (!serviceMethods) {
      return null
    }
    const handler = serviceMethods[methodID]
    if (!handler) {
      return null
    }
    return await handler.lookupMethod(serviceID, methodID)
  }
}
