interface RpcDebugRecord {
  id: number
  service: string
  method: string
  state: 'open' | 'closed'
  startedAt: number
  closedAt?: number
  closeReason?: string
}

interface PairCountEntry {
  service: string
  method: string
  count: number
}

interface RpcDebugSnapshot {
  totalCount: number
  activeCount: number
  closedCount: number
  activeByPair: PairCountEntry[]
  closedByPair: PairCountEntry[]
}

interface DebugSnapshot {
  rpc: RpcDebugSnapshot
}

interface RpcDebugTracker {
  nextRpcId: number
  rpcs: Map<number, RpcDebugRecord>
  registerRpc: (service: string, method: string) => number
  closeRpc: (id: number, reason?: string) => void
  reset: () => void
  rpcSnapshot: () => RpcDebugSnapshot
  snapshot: () => DebugSnapshot
}

function buildPairCounts(
  records: Iterable<RpcDebugRecord>,
  state: RpcDebugRecord['state'],
): PairCountEntry[] {
  const counts = new Map<string, number>()
  for (const record of records) {
    if (record.state !== state) {
      continue
    }
    const key = `${record.service}/${record.method}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const slash = key.lastIndexOf('/')
      return {
        service: key.slice(0, slash),
        method: key.slice(slash + 1),
        count,
      }
    })
    .sort((a, b) => {
      if (a.count !== b.count) {
        return b.count - a.count
      }
      return `${a.service}/${a.method}`.localeCompare(
        `${b.service}/${b.method}`,
      )
    })
}

function createRpcDebugTracker(): RpcDebugTracker {
  return {
    nextRpcId: 1,
    rpcs: new Map(),
    registerRpc(service: string, method: string) {
      const id = this.nextRpcId++
      this.rpcs.set(id, {
        id,
        service,
        method,
        state: 'open',
        startedAt: Date.now(),
      })
      return id
    },
    closeRpc(id: number, reason?: string) {
      const record = this.rpcs.get(id)
      if (!record || record.state === 'closed') {
        return
      }
      record.state = 'closed'
      record.closedAt = Date.now()
      record.closeReason = reason
    },
    reset() {
      this.nextRpcId = 1
      this.rpcs.clear()
    },
    rpcSnapshot() {
      const values = [...this.rpcs.values()]
      return {
        totalCount: values.length,
        activeCount: values.filter((record) => record.state === 'open').length,
        closedCount: values.filter((record) => record.state === 'closed')
          .length,
        activeByPair: buildPairCounts(values, 'open').slice(0, 20),
        closedByPair: buildPairCounts(values, 'closed').slice(0, 20),
      }
    },
    snapshot() {
      return { rpc: this.rpcSnapshot() }
    },
  }
}

export function getRpcDebugTracker(): RpcDebugTracker {
  const scope = globalThis as typeof globalThis & {
    __APTRE_RPC_DEBUG__?: RpcDebugTracker
  }
  if (!scope.__APTRE_RPC_DEBUG__) {
    scope.__APTRE_RPC_DEBUG__ = createRpcDebugTracker()
  }
  if (!scope.__APTRE_RPC_DEBUG__.registerRpc) {
    const tracker = createRpcDebugTracker()
    scope.__APTRE_RPC_DEBUG__.nextRpcId = tracker.nextRpcId
    scope.__APTRE_RPC_DEBUG__.rpcs = tracker.rpcs
    scope.__APTRE_RPC_DEBUG__.registerRpc = tracker.registerRpc
    scope.__APTRE_RPC_DEBUG__.closeRpc = tracker.closeRpc
    scope.__APTRE_RPC_DEBUG__.reset = tracker.reset
    scope.__APTRE_RPC_DEBUG__.rpcSnapshot = tracker.rpcSnapshot
    scope.__APTRE_RPC_DEBUG__.snapshot = tracker.snapshot
  }
  return scope.__APTRE_RPC_DEBUG__
}
