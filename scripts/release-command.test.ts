import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'

interface PackageManifest {
  version: string
}

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim()
}

it('creates and publishes a signed release commit and tag', () => {
  const repo = process.cwd()
  const root = mkdtempSync(join(tmpdir(), 'starpc-release-'))
  const remote = join(root, 'origin.git')
  const work = join(root, 'work')

  try {
    run('git', ['init', '-q', '--bare', remote], root)
    run('git', ['init', '-q', work], root)
    mkdirSync(join(work, 'scripts'))
    copyFileSync(join(repo, 'package.json'), join(work, 'package.json'))
    copyFileSync(join(repo, 'Cargo.toml'), join(work, 'Cargo.toml'))
    copyFileSync(
      join(repo, 'scripts/release-version.ts'),
      join(work, 'scripts/release-version.ts'),
    )

    run('git', ['branch', '-M', 'master'], work)
    run('git', ['config', 'user.name', 'Release Test'], work)
    run('git', ['config', 'user.email', 'release-test@example.com'], work)
    run('git', ['add', '.'], work)
    run('git', ['commit', '-q', '-m', 'test: release baseline'], work)
    run('git', ['remote', 'add', 'origin', remote], work)
    run('git', ['push', '-q', '-u', 'origin', 'master'], work)

    const manifest = JSON.parse(
      readFileSync(join(work, 'package.json'), 'utf8'),
    ) as PackageManifest
    const [major, minor, patch] = manifest.version.split('.').map(Number)
    const version = `${major}.${minor}.${patch + 1}`

    run('bun', ['run', 'release'], work)

    expect(
      (
        JSON.parse(
          readFileSync(join(work, 'package.json'), 'utf8'),
        ) as PackageManifest
      ).version,
    ).toBe(version)
    expect(readFileSync(join(work, 'Cargo.toml'), 'utf8')).toContain(
      `version = "${version}"`,
    )
    expect(run('git', ['log', '-1', '--format=%s'], work)).toBe(
      `release: v${version}`,
    )
    expect(run('git', ['rev-parse', `v${version}`], work)).toBe(
      run('git', ['rev-parse', 'HEAD'], work),
    )

    run('bun', ['run', 'release:publish'], work)

    const head = run('git', ['rev-parse', 'HEAD'], work)
    expect(
      run(
        'git',
        [`--git-dir=${remote}`, 'rev-parse', 'refs/heads/master'],
        root,
      ),
    ).toBe(head)
    expect(
      run(
        'git',
        [`--git-dir=${remote}`, 'rev-parse', `refs/tags/v${version}`],
        root,
      ),
    ).toBe(head)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
