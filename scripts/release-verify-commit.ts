// release-verify-commit proves that a release commit was already reviewed and
// merged through a protected pull request before any tag or publish consumes it.
// The pure evaluateReleaseCommit decision is exercised by the co-located test;
// main wires it to the GitHub CLI so the same rule runs locally and in CI.

import { execFileSync } from 'node:child_process'

// DEFAULT_RELEASE_REQUIRED_CHECKS is the complete CI contract for a release.
export const DEFAULT_RELEASE_REQUIRED_CHECKS = [
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
] as const

// AssociatedPullRequest is the review and merge state of a pull request
// associated with the release commit.
export interface AssociatedPullRequest {
  number: number
  state: 'OPEN' | 'CLOSED' | 'MERGED'
  merged: boolean
  baseRefName: string
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
  mergeCommit: { oid: string } | null
}

// CommitCheck is one CI check run reported against the release commit.
export interface CommitCheck {
  id: number
  name: string
  status: string
  conclusion: string | null
  started_at: string
}

// ReleaseCommitInfo is the GitHub state gathered for a candidate release commit.
export interface ReleaseCommitInfo {
  protectedBranch: string
  requiredChecks: readonly string[]
  pullRequests: AssociatedPullRequest[]
  checks: CommitCheck[]
}

// ReleaseCommitVerdict is the outcome of evaluating a release commit.
export interface ReleaseCommitVerdict {
  ok: boolean
  reasons: string[]
}

// evaluateReleaseCommit rejects any commit that did not enter the protected
// branch through an approved, merged pull request with green required CI. It is
// pure: callers supply the already-fetched GitHub state.
export function evaluateReleaseCommit(
  commit: string,
  info: ReleaseCommitInfo,
): ReleaseCommitVerdict {
  const reasons: string[] = []

  const merged = info.pullRequests.filter(
    (pr) =>
      pr.merged &&
      pr.state === 'MERGED' &&
      pr.baseRefName === info.protectedBranch &&
      pr.mergeCommit?.oid === commit,
  )
  if (merged.length === 0) {
    reasons.push(
      `commit ${commit} is not the merge commit of a merged pull request into ${info.protectedBranch}`,
    )
  }

  const approved = merged.filter((pr) => pr.reviewDecision === 'APPROVED')
  if (merged.length !== 0 && approved.length === 0) {
    reasons.push(
      `merged pull request ${merged.map((pr) => `#${pr.number}`).join(', ')} lacks an APPROVED review`,
    )
  }

  if (info.requiredChecks.length === 0) {
    reasons.push('no required release checks are configured')
  }

  for (const required of info.requiredChecks) {
    const checks = info.checks.filter((check) => check.name === required)
    if (checks.length === 0) {
      reasons.push(`required check ${required} is missing for ${commit}`)
      continue
    }
    const check = checks.reduce((latest, candidate) =>
      candidate.started_at > latest.started_at ||
      (candidate.started_at === latest.started_at && candidate.id > latest.id)
        ? candidate
        : latest,
    )
    if (check.conclusion !== 'success') {
      reasons.push(
        `required check ${required} concluded ${check.conclusion ?? check.status}, not success`,
      )
    }
  }

  return { ok: reasons.length === 0, reasons }
}

// GitHubCLI runs a GitHub CLI command and parses its JSON output.
export type GitHubCLI = <T>(args: string[]) => T

// gh runs the GitHub CLI and returns parsed JSON output.
function gh<T>(args: string[]): T {
  const out = execFileSync('gh', args, { encoding: 'utf8' })
  return JSON.parse(out) as T
}

// fetchReleaseCommitInfo gathers the associated pull requests and check runs for
// a commit through the GitHub CLI.
export function fetchReleaseCommitInfo(
  repo: string,
  commit: string,
  protectedBranch: string,
  requiredChecks: readonly string[],
  cli: GitHubCLI = gh,
): ReleaseCommitInfo {
  const associated = cli<Array<Array<{ number: number }>>>([
    'api',
    `repos/${repo}/commits/${commit}/pulls?per_page=100`,
    '--paginate',
    '--slurp',
  ]).flat()

  const pullRequests: AssociatedPullRequest[] = associated.map((pr) =>
    cli<AssociatedPullRequest>([
      'pr',
      'view',
      String(pr.number),
      '--repo',
      repo,
      '--json',
      'number,state,merged,baseRefName,reviewDecision,mergeCommit',
    ]),
  )

  const checks = cli<Array<{ check_runs: CommitCheck[] }>>([
    'api',
    `repos/${repo}/commits/${commit}/check-runs?per_page=100`,
    '--paginate',
    '--slurp',
  ]).flatMap((page) => page.check_runs)

  return { protectedBranch, requiredChecks, pullRequests, checks }
}

// main verifies the commit named on the command line, GITHUB_SHA, or HEAD.
function main(): void {
  const repo =
    process.env.GITHUB_REPOSITORY ??
    gh<{ nameWithOwner: string }>(['repo', 'view', '--json', 'nameWithOwner'])
      .nameWithOwner
  const commit =
    process.argv[2] ??
    process.env.GITHUB_SHA ??
    execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const protectedBranch = process.env.RELEASE_PROTECTED_BRANCH ?? 'master'
  const requiredChecks =
    process.env.RELEASE_REQUIRED_CHECKS === undefined
      ? DEFAULT_RELEASE_REQUIRED_CHECKS
      : process.env.RELEASE_REQUIRED_CHECKS.split(',')
          .map((s) => s.trim())
          .filter((s) => s.length !== 0)

  const info = fetchReleaseCommitInfo(
    repo,
    commit,
    protectedBranch,
    requiredChecks,
  )
  const verdict = evaluateReleaseCommit(commit, info)
  if (!verdict.ok) {
    console.error(`release commit ${commit} rejected:`)
    for (const reason of verdict.reasons) {
      console.error(`  - ${reason}`)
    }
    process.exit(1)
  }
  console.log(`release commit ${commit} is reviewed, merged, and green`)
}

if (import.meta.main) {
  main()
}
