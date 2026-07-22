import { describe, expect, it } from 'vitest'

import {
  DEFAULT_RELEASE_REQUIRED_CHECKS,
  evaluateReleaseCommit,
  fetchReleaseCommitInfo,
  type CommitCheck,
  type ReleaseCommitInfo,
} from './release-verify-commit.js'

const commit = 'deadbeefcafebabe0000000000000000deadbeef'

function commitCheck(
  id: number,
  name: string,
  startedAt: string,
  conclusion: string | null = 'success',
  status = 'completed',
): CommitCheck {
  return { id, name, status, conclusion, started_at: startedAt }
}

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
      commitCheck(1001, 'Go', '2026-07-21T18:00:01Z'),
      commitCheck(1002, 'JavaScript', '2026-07-21T18:00:02Z'),
      commitCheck(
        1003,
        'Cross-language (go:ts)',
        '2026-07-21T18:00:03Z',
      ),
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
            commitCheck(2001, 'JavaScript', '2026-07-21T18:01:01Z'),
          ],
        },
        {
          check_runs: [
            commitCheck(
              2002,
              'Cross-language (cpp:cpp)',
              '2026-07-21T18:01:02Z',
            ),
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
          commitCheck(
            3001,
            'Go',
            '2026-07-21T18:02:01Z',
            'failure',
          ),
          commitCheck(3002, 'JavaScript', '2026-07-21T18:02:02Z'),
          commitCheck(
            3003,
            'Cross-language (go:ts)',
            '2026-07-21T18:02:03Z',
          ),
        ],
      }),
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.reasons.join(' ')).toContain('Go concluded failure')
  })

  it('rejects a newer failed run in either API order', () => {
    const older = commitCheck(4001, 'Go', '2026-07-21T18:03:01Z')
    const newer = commitCheck(
      4002,
      'Go',
      '2026-07-21T18:03:02Z',
      'failure',
    )

    for (const checks of [
      [older, newer],
      [newer, older],
    ]) {
      const verdict = evaluateReleaseCommit(
        commit,
        reviewedInfo({ requiredChecks: ['Go'], checks }),
      )
      expect(verdict.ok).toBe(false)
      expect(verdict.reasons.join(' ')).toContain('Go concluded failure')
    }
  })

  it('rejects a newer in-progress run over an older success', () => {
    const verdict = evaluateReleaseCommit(
      commit,
      reviewedInfo({
        requiredChecks: ['Go'],
        checks: [
          commitCheck(4051, 'Go', '2026-07-21T18:03:01Z'),
          commitCheck(
            4052,
            'Go',
            '2026-07-21T18:03:02Z',
            null,
            'in_progress',
          ),
        ],
      }),
    )

    expect(verdict.ok).toBe(false)
    expect(verdict.reasons.join(' ')).toContain('Go concluded in_progress')
  })

  it('accepts a newer successful run in either API order', () => {
    const older = commitCheck(
      4101,
      'Go',
      '2026-07-21T18:03:03Z',
      'failure',
    )
    const newer = commitCheck(4102, 'Go', '2026-07-21T18:03:04Z')

    for (const checks of [
      [older, newer],
      [newer, older],
    ]) {
      const verdict = evaluateReleaseCommit(
        commit,
        reviewedInfo({ requiredChecks: ['Go'], checks }),
      )
      expect(verdict).toEqual({ ok: true, reasons: [] })
    }
  })

  it('uses the largest check-run id when start times tie', () => {
    const startedAt = '2026-07-21T18:03:05Z'
    const verdict = evaluateReleaseCommit(
      commit,
      reviewedInfo({
        requiredChecks: ['Go'],
        checks: [
          commitCheck(4202, 'Go', startedAt, 'failure'),
          commitCheck(4201, 'Go', startedAt),
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
          commitCheck(5001, 'JavaScript', '2026-07-21T18:04:01Z'),
        ],
      }),
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.reasons.join(' ')).toContain('missing')
  })
})
