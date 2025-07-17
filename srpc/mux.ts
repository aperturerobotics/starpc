import { InvokeFn, Handler } from './handler.js'

// LookupMethod is a function to lookup a RPC method.
export type LookupMethod = (
  serviceID: string,
  methodID: string,
) => Promise<InvokeFn | null>

// Mux contains a set of <service, method> handlers.
export interface Mux {
  // lookupMethod looks up the method matching the service & method ID.
  // returns null if not found.
  lookupMethod(serviceID: string, methodID: string): Promise<InvokeFn | null>
}

// createMux builds a new StaticMux.
export function createMux(): StaticMux {
  return new StaticMux()
}

// createMultiMux builds a new MultiMux.
export function createMultiMux(): MultiMux {
  return new MultiMux()
}

// staticMuxMethods is a mapping from method id to handler.
type staticMuxMethods = { [methodID: string]: Handler }

// StaticMux contains a in-memory mapping between service ID and handlers.
// implements Mux
export class StaticMux implements Mux {
  // services contains a mapping from service id to handlers.
  private services: { [id: string]: staticMuxMethods } = {}
  // lookups is the list of lookup methods to call.
  // called if the method is not resolved by the services list.
  private lookups: LookupMethod[] = []

  // lookupMethod implements the LookupMethod type.
  public get lookupMethod(): LookupMethod {
    return this._lookupMethod.bind(this)
  }

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

  // registerLookupMethod registers a extra lookup function to the mux.
  public registerLookupMethod(lookupMethod: LookupMethod) {
    this.lookups.push(lookupMethod)
  }

  private async _lookupMethod(
    serviceID: string,
    methodID: string,
  ): Promise<InvokeFn | null> {
    if (serviceID) {
      const invokeFn = await this.lookupViaMap(serviceID, methodID)
      if (invokeFn) {
        return invokeFn
      }
    }

    return await this.lookupViaLookups(serviceID, methodID)
  }

  // lookupViaMap looks up the method via the services map.
  private async lookupViaMap(
    serviceID: string,
    methodID: string,
  ): Promise<InvokeFn | null> {
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

  // lookupViaLookups looks up the method via the lookup funcs.
  private async lookupViaLookups(
    serviceID: string,
    methodID: string,
  ): Promise<InvokeFn | null> {
    for (const lookupMethod of this.lookups) {
      const invokeFn = await lookupMethod(serviceID, methodID)
      if (invokeFn) {
        return invokeFn
      }
    }

    return null
  }
}

// MultiMux allows registering multiple Mux instances and implements Mux itself.
// implements Mux
export class MultiMux implements Mux {
  // muxes stores the registered mux instances with their IDs
  private muxes: Map<number, Mux> = new Map()
  // muxIdCounter generates unique IDs for registered muxes
  private muxIdCounter: number = 0

  // lookupMethod implements the LookupMethod type.
  public get lookupMethod(): LookupMethod {
    return this._lookupMethod.bind(this)
  }

  // register adds a mux to the MultiMux and returns an ID for later removal.
  public register(mux: Mux): number {
    const id = ++this.muxIdCounter
    this.muxes.set(id, mux)
    return id
  }

  // unregister removes a mux from the MultiMux using its ID.
  // returns true if the mux was found and removed, false otherwise.
  public unregister(id: number): boolean {
    return this.muxes.delete(id)
  }

  private async _lookupMethod(
    serviceID: string,
    methodID: string,
  ): Promise<InvokeFn | null> {
    // Try each registered mux in order
    for (const mux of this.muxes.values()) {
      const invokeFn = await mux.lookupMethod(serviceID, methodID)
      if (invokeFn) {
        return invokeFn
      }
    }

    return null
  }
}
