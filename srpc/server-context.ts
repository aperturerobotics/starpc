declare const contextKeyValue: unique symbol
const contextParent = Symbol('server context parent')
const contextKey = Symbol('server context key')
const contextStoredValue = Symbol('server context value')

// ContextKey identifies one typed server-context value.
export interface ContextKey<T> {
  readonly [contextKeyValue]?: T
}

// ServerContext carries cancellation for one server invocation.
export interface ServerContext {
  readonly signal: AbortSignal
}

type StoredServerContext = ServerContext & {
  readonly [contextParent]?: ServerContext
  readonly [contextKey]?: ContextKey<unknown>
  readonly [contextStoredValue]?: unknown
}

// createContextKey constructs an identity key for one server-context value.
export function createContextKey<T>(): ContextKey<T> {
  return {}
}

// withServerContextValue derives a context with one immutable typed value.
export function withServerContextValue<T>(
  context: ServerContext,
  key: ContextKey<T>,
  value: T,
): ServerContext {
  const derived: StoredServerContext = {
    signal: context.signal,
    [contextParent]: context,
    [contextKey]: key as ContextKey<unknown>,
    [contextStoredValue]: value,
  }
  return derived
}

// serverContextValue retrieves the nearest value for a typed identity key.
export function serverContextValue<T>(
  context: ServerContext,
  key: ContextKey<T>,
): T | undefined {
  let current: StoredServerContext | undefined = context as StoredServerContext
  while (current) {
    if (current[contextKey] === key) {
      return current[contextStoredValue] as T
    }
    current = current[contextParent] as StoredServerContext | undefined
  }
  return undefined
}
