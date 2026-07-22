import { describe, expect, it, vi } from 'vitest'

import {
  releaseTagFromCommit,
  releaseVersionFromCommit,
} from './release-tag.js'

const commit = 'deadbeefcafebabe0000000000000000deadbeef'

describe('releaseVersionFromCommit', () => {
  it('reads matching package and Cargo versions from the supplied commit', () => {
    const readCommitFile = vi.fn((_commit: string, path: string) => {
      if (path === 'package.json') {
        return JSON.stringify({ version: '1.2.3' })
      }
      if (path === 'Cargo.toml') {
        return '[package]\nversion = "1.2.3"\n'
      }
      throw new Error(`unexpected path: ${path}`)
    })

    expect(releaseVersionFromCommit(commit, readCommitFile)).toBe('1.2.3')
    expect(readCommitFile).toHaveBeenNthCalledWith(1, commit, 'package.json')
    expect(readCommitFile).toHaveBeenNthCalledWith(2, commit, 'Cargo.toml')
  })

  it('rejects a malformed package version', () => {
    const readCommitFile = vi.fn((_commit: string, _path: string) =>
      JSON.stringify({ version: '1.2' }),
    )

    expect(() => releaseVersionFromCommit(commit, readCommitFile)).toThrow(
      'unsupported package version: 1.2',
    )
  })

  it('rejects a package and Cargo version mismatch', () => {
    const readCommitFile = vi.fn((_commit: string, path: string) =>
      path === 'package.json' ?
        JSON.stringify({ version: '1.2.3' })
      : '[package]\nversion = "1.2.4"\n',
    )

    expect(() => releaseVersionFromCommit(commit, readCommitFile)).toThrow(
      'package version 1.2.3 does not match Cargo version 1.2.4',
    )
  })
})

describe('releaseTagFromCommit', () => {
  it('builds the expected tag from the supplied commit', () => {
    const readCommitFile = vi.fn((_commit: string, path: string) =>
      path === 'package.json' ?
        JSON.stringify({ version: '1.2.3' })
      : '[package]\nversion = "1.2.3"\n',
    )

    expect(releaseTagFromCommit(commit, readCommitFile)).toBe('v1.2.3')
  })
})
