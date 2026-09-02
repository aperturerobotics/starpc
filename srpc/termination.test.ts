import { describe, expect, it } from 'vitest'

import { TerminationGate } from './termination.js'

describe('TerminationGate', () => {
  it('prioritizes termination over an already-ready result', async () => {
    const gate = new TerminationGate()
    const iterator = (async function* () {
      yield 1
    })()
    const pending = gate.next(iterator)
    const error = new Error('stopped')

    gate.terminate(error)

    await expect(pending).resolves.toEqual({ terminated: true, error })
  })

  it('keeps the first termination result', async () => {
    const gate = new TerminationGate()
    const error = new Error('stopped')

    expect(gate.terminate(error)).toBe(true)
    expect(gate.terminate()).toBe(false)
    await expect(gate.wait(new Promise<void>(() => {}))).resolves.toEqual({
      terminated: true,
      error,
    })
  })
})
