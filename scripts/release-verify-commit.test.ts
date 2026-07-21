import { describe, expect, it } from 'vitest'

import {
  DEFAULT_RELEASE_REQUIRED_CHECKS,
  evaluateReleaseCommit,
  fetchReleaseCommitInfo,
  type ReleaseCommitInfo,
} from './release-verify-commit.js'

const commit = 'deadbeefcafebabe0000000000000000deadbeef'

function reviewedInfo(
  overrides: Partial<ReleaseCommitInfo> = {},
): ReleaseCommitInfo {
  return {
    protectedBranch: 'master',
    requiredChecks: ['Go', 'JavaScript', 'Cross-language (go:ts)'],
    pullRequests: [
      {
        number: 42,
        state: 'MERGED',
        merged: true,
        baseRefName: 'master',
        reviewDecision: 'APPROVED',
        mergeCommit: { oid: commit },
      },
    ],
    checks: [
      { name: 'Go', status: 'completed', conclusion: 'success' },
      { name: 'JavaScript', status: 'completed', conclusion: 'success' },
      {
        name: 'Cross-language (go:ts)',
        status: 'completed',
        conclusion: 'success',
      },
    ],
    ...overrides,
  }
}

describe('release commit information', () => {
  it('requires every language and cross-language CI check by default', () => {
    expect(DEFAULT_RELEASE_REQUIRED_CHECKS).toEqual([
      'JavaScript',
      'Go',
      'Rust',
      'C++',
      'Cross-language (go:go)',
      'Cross-language (go:ts)',
      'Cross-language (go:rust)',
      'Cross-language (go:cpp)',
      'Cross-language (ts:ts)',
      'Cross-language (ts:rust)',
      'Cross-language (ts:cpp)',
      'Cross-language (rust:rust)',
      'Cross-language (rust:cpp)',
      'Cross-language (cpp:cpp)',
    ])
  })

  it('collects every associated pull request and check-run page', () => {
    const calls: string[][] = []
    const cli = <T>(args: string[]): T => {
      calls.push(args)
      if (args[0] === 'pr') {
        return {
          number: Number(args[2]),
          state: 'MERGED',
          merged: true,
          baseRefName: 'master',
          reviewDecision: 'APPROVED',
          mergeCommit: { oid: commit },
        } as T
      }
      if (args[1]?.includes('/pulls?')) {
        return [[{ number: 41 }], [{ number: 42 }]] as T
      }
      return [
        {
          check_runs: [
            { name: 'JavaScript', status: 'completed', conclusion: 'success' },
          ],
        },
        {
          check_runs: [
            {
              name: 'Cross-language (cpp:cpp)',
              status: 'completed',
              conclusion: 'success',
            },
          ],
        },
      ] as T
    }

    const info = fetchReleaseCommitInfo(
      'aperturerobotics/starpc',
      commit,
      'master',
      DEFAULT_RELEASE_REQUIRED_CHECKS,
      cli,
    )

    expect(info.pullRequests.map((pr) => pr.number)).toEqual([41, 42])
    expect(info.checks.map((check) => check.name)).toEqual([
      'JavaScript',
      'Cross-language (cpp:cpp)',
    ])
    const apiCalls = calls.filter((args) => args[0] === 'api')
    expect(apiCalls).toHaveLength(2)
    for (const args of apiCalls) {
      expect(args).toContain('--paginate')
      expect(args).toContain('--slurp')
    }
  })
})

describe('evaluateReleaseCommit', () => {
  it('accepts an approved, merged commit with green required CI', () => {
    const verdict = evaluateReleaseCommit(commit, reviewedInfo())
    expect(verdict.ok).toBe(true)
    expect(verdict.reasons).toEqual([])
  })

  it('rejects an unreviewed commit pushed straight to the protected branch', () => {
    const verdict = evaluateReleaseCommit(
      commit,
      reviewedInfo({ pullRequests: [] }),
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.reasons.join(' ')).toContain('not the merge commit')
  })

  it('rejects a merged commit that was never approved', () => {
    const verdict = evaluateReleaseCommit(
      commit,
      reviewedInfo({
        pullRequests: [
          {
            number: 42,
            state: 'MERGED',
            merged: true,
            baseRefName: 'master',
            reviewDecision: 'REVIEW_REQUIRED',
            mergeCommit: { oid: commit },
          },
        ],
      }),
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.reasons.join(' ')).toContain('APPROVED')
  })

  it('rejects a mismatched commit merged into a different base', () => {
    const verdict = evaluateReleaseCommit(
      commit,
      reviewedInfo({
        pullRequests: [
          {
            number: 42,
            state: 'MERGED',
            merged: true,
            baseRefName: 'topic-branch',
            reviewDecision: 'APPROVED',
            mergeCommit: { oid: commit },
          },
        ],
      }),
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.reasons.join(' ')).toContain('not the merge commit')
  })

  it('rejects a reviewed feature commit instead of the merged commit', () => {
    const verdict = evaluateReleaseCommit(
      commit,
      reviewedInfo({
        pullRequests: [
          {
            number: 42,
            state: 'MERGED',
            merged: true,
            baseRefName: 'master',
            reviewDecision: 'APPROVED',
            mergeCommit: { oid: '1111111111111111111111111111111111111111' },
          },
        ],
      }),
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.reasons.join(' ')).toContain('not the merge commit')
  })

  it('rejects an empty required-check configuration', () => {
    const verdict = evaluateReleaseCommit(
      commit,
      reviewedInfo({ requiredChecks: [] }),
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.reasons.join(' ')).toContain('no required release checks')
  })

  it('rejects when a required check failed', () => {
    const verdict = evaluateReleaseCommit(
      commit,
      reviewedInfo({
        checks: [
          { name: 'Go', status: 'completed', conclusion: 'failure' },
          { name: 'JavaScript', status: 'completed', conclusion: 'success' },
          {
            name: 'Cross-language (go:ts)',
            status: 'completed',
            conclusion: 'success',
          },
        ],
      }),
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.reasons.join(' ')).toContain('Go concluded failure')
  })

  it('rejects when a required check is missing', () => {
    const verdict = evaluateReleaseCommit(
      commit,
      reviewedInfo({
        checks: [
          { name: 'JavaScript', status: 'completed', conclusion: 'success' },
        ],
      }),
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.reasons.join(' ')).toContain('missing')
  })
})
