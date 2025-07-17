import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  createMux,
  createMultiMux,
  StaticMux,
  MultiMux,
  LookupMethod,
} from './mux.js'
import { Handler, InvokeFn } from './handler.js'

// Mock handler for testing
class MockHandler implements Handler {
  constructor(
    private serviceID: string,
    private methodIDs: string[],
    private mockInvokeFn: InvokeFn | null = null,
  ) {}

  getServiceID(): string {
    return this.serviceID
  }

  getMethodIDs(): string[] {
    return this.methodIDs
  }

  async lookupMethod(
    serviceID: string,
    methodID: string,
  ): Promise<InvokeFn | null> {
    if (serviceID === this.serviceID && this.methodIDs.includes(methodID)) {
      return this.mockInvokeFn
    }
    return null
  }
}

describe('StaticMux', () => {
  let mux: StaticMux
  let mockInvokeFn: InvokeFn

  beforeEach(() => {
    mux = createMux()
    mockInvokeFn = vi.fn()
  })

  it('should create a new StaticMux', () => {
    expect(mux).toBeInstanceOf(StaticMux)
    expect(typeof mux.lookupMethod).toBe('function')
  })

  it('should register and lookup handlers', async () => {
    const handler = new MockHandler(
      'testService',
      ['method1', 'method2'],
      mockInvokeFn,
    )
    mux.register(handler)

    const result1 = await mux.lookupMethod('testService', 'method1')
    const result2 = await mux.lookupMethod('testService', 'method2')

    expect(result1).toBe(mockInvokeFn)
    expect(result2).toBe(mockInvokeFn)
  })

  it('should return null for unknown service', async () => {
    const handler = new MockHandler('testService', ['method1'], mockInvokeFn)
    mux.register(handler)

    const result = await mux.lookupMethod('unknownService', 'method1')
    expect(result).toBeNull()
  })

  it('should return null for unknown method', async () => {
    const handler = new MockHandler('testService', ['method1'], mockInvokeFn)
    mux.register(handler)

    const result = await mux.lookupMethod('testService', 'unknownMethod')
    expect(result).toBeNull()
  })

  it('should throw error for handler with empty service ID', () => {
    const handler = new MockHandler('', ['method1'], mockInvokeFn)

    expect(() => mux.register(handler)).toThrow('service id cannot be empty')
  })

  it('should handle multiple handlers for same service', async () => {
    const mockInvokeFn2 = vi.fn()
    const handler1 = new MockHandler('testService', ['method1'], mockInvokeFn)
    const handler2 = new MockHandler('testService', ['method2'], mockInvokeFn2)

    mux.register(handler1)
    mux.register(handler2)

    const result1 = await mux.lookupMethod('testService', 'method1')
    const result2 = await mux.lookupMethod('testService', 'method2')

    expect(result1).toBe(mockInvokeFn)
    expect(result2).toBe(mockInvokeFn2)
  })

  it('should override methods when registering handler with same service and method', async () => {
    const mockInvokeFn2 = vi.fn()
    const handler1 = new MockHandler('testService', ['method1'], mockInvokeFn)
    const handler2 = new MockHandler('testService', ['method1'], mockInvokeFn2)

    mux.register(handler1)
    mux.register(handler2)

    const result = await mux.lookupMethod('testService', 'method1')
    expect(result).toBe(mockInvokeFn2)
  })

  it('should register and use lookup methods', async () => {
    const mockLookupMethod: LookupMethod = vi
      .fn()
      .mockResolvedValue(mockInvokeFn)
    mux.registerLookupMethod(mockLookupMethod)

    const result = await mux.lookupMethod('externalService', 'externalMethod')

    expect(mockLookupMethod).toHaveBeenCalledWith(
      'externalService',
      'externalMethod',
    )
    expect(result).toBe(mockInvokeFn)
  })

  it('should prioritize registered handlers over lookup methods', async () => {
    const mockLookupMethod: LookupMethod = vi.fn().mockResolvedValue(vi.fn())
    const handler = new MockHandler('testService', ['method1'], mockInvokeFn)

    mux.register(handler)
    mux.registerLookupMethod(mockLookupMethod)

    const result = await mux.lookupMethod('testService', 'method1')

    expect(mockLookupMethod).not.toHaveBeenCalled()
    expect(result).toBe(mockInvokeFn)
  })

  it('should try multiple lookup methods in order', async () => {
    const mockLookupMethod1: LookupMethod = vi.fn().mockResolvedValue(null)
    const mockLookupMethod2: LookupMethod = vi
      .fn()
      .mockResolvedValue(mockInvokeFn)
    const mockLookupMethod3: LookupMethod = vi.fn().mockResolvedValue(vi.fn())

    mux.registerLookupMethod(mockLookupMethod1)
    mux.registerLookupMethod(mockLookupMethod2)
    mux.registerLookupMethod(mockLookupMethod3)

    const result = await mux.lookupMethod('externalService', 'externalMethod')

    expect(mockLookupMethod1).toHaveBeenCalledWith(
      'externalService',
      'externalMethod',
    )
    expect(mockLookupMethod2).toHaveBeenCalledWith(
      'externalService',
      'externalMethod',
    )
    expect(mockLookupMethod3).not.toHaveBeenCalled()
    expect(result).toBe(mockInvokeFn)
  })
})

describe('MultiMux', () => {
  let multiMux: MultiMux
  let mockInvokeFn: InvokeFn

  beforeEach(() => {
    multiMux = createMultiMux()
    mockInvokeFn = vi.fn()
  })

  it('should create a new MultiMux', () => {
    expect(multiMux).toBeInstanceOf(MultiMux)
    expect(typeof multiMux.lookupMethod).toBe('function')
  })

  it('should register and lookup via sub-muxes', async () => {
    const subMux = createMux()
    const handler = new MockHandler('testService', ['method1'], mockInvokeFn)
    subMux.register(handler)

    const id = multiMux.register(subMux)
    expect(typeof id).toBe('number')

    const result = await multiMux.lookupMethod('testService', 'method1')
    expect(result).toBe(mockInvokeFn)
  })

  it('should return null when no muxes are registered', async () => {
    const result = await multiMux.lookupMethod('testService', 'method1')
    expect(result).toBeNull()
  })

  it('should return null when method not found in any mux', async () => {
    const subMux = createMux()
    const handler = new MockHandler('testService', ['method1'], mockInvokeFn)
    subMux.register(handler)

    multiMux.register(subMux)

    const result = await multiMux.lookupMethod(
      'unknownService',
      'unknownMethod',
    )
    expect(result).toBeNull()
  })

  it('should unregister muxes', async () => {
    const subMux = createMux()
    const handler = new MockHandler('testService', ['method1'], mockInvokeFn)
    subMux.register(handler)

    const id = multiMux.register(subMux)

    // Should find method before unregistering
    let result = await multiMux.lookupMethod('testService', 'method1')
    expect(result).toBe(mockInvokeFn)

    // Unregister the mux
    const unregistered = multiMux.unregister(id)
    expect(unregistered).toBe(true)

    // Should not find method after unregistering
    result = await multiMux.lookupMethod('testService', 'method1')
    expect(result).toBeNull()
  })

  it('should return false when unregistering non-existent mux', () => {
    const result = multiMux.unregister(999)
    expect(result).toBe(false)
  })

  it('should try muxes in registration order', async () => {
    const mockInvokeFn2 = vi.fn()

    const subMux1 = createMux()
    const handler1 = new MockHandler('testService', ['method1'], mockInvokeFn)
    subMux1.register(handler1)

    const subMux2 = createMux()
    const handler2 = new MockHandler('testService', ['method1'], mockInvokeFn2)
    subMux2.register(handler2)

    multiMux.register(subMux1)
    multiMux.register(subMux2)

    const result = await multiMux.lookupMethod('testService', 'method1')
    // Should return the first match (from subMux1)
    expect(result).toBe(mockInvokeFn)
  })

  it('should handle multiple different services across muxes', async () => {
    const mockInvokeFn2 = vi.fn()

    const subMux1 = createMux()
    const handler1 = new MockHandler('service1', ['method1'], mockInvokeFn)
    subMux1.register(handler1)

    const subMux2 = createMux()
    const handler2 = new MockHandler('service2', ['method2'], mockInvokeFn2)
    subMux2.register(handler2)

    multiMux.register(subMux1)
    multiMux.register(subMux2)

    const result1 = await multiMux.lookupMethod('service1', 'method1')
    const result2 = await multiMux.lookupMethod('service2', 'method2')

    expect(result1).toBe(mockInvokeFn)
    expect(result2).toBe(mockInvokeFn2)
  })

  it('should generate unique IDs for each registered mux', () => {
    const subMux1 = createMux()
    const subMux2 = createMux()

    const id1 = multiMux.register(subMux1)
    const id2 = multiMux.register(subMux2)

    expect(id1).not.toBe(id2)
    expect(typeof id1).toBe('number')
    expect(typeof id2).toBe('number')
  })
})
