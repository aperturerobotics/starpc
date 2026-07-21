import { readFileSync, writeFileSync } from 'node:fs'

type Bump = 'patch' | 'minor'

interface PackageManifest {
  version: string
  [key: string]: unknown
}

function nextVersion(version: string, bump: Bump): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version)
  if (!match) {
    throw new Error(`unsupported package version: ${version}`)
  }

  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3])
  return bump === 'minor' ?
      `${major}.${minor + 1}.0`
    : `${major}.${minor}.${patch + 1}`
}

const bump = process.argv[2] ?? 'patch'
if (bump !== 'patch' && bump !== 'minor') {
  throw new Error(`unsupported release increment: ${bump}`)
}

const packagePath = 'package.json'
const cargoPath = 'Cargo.toml'
const manifest = JSON.parse(
  readFileSync(packagePath, 'utf8'),
) as PackageManifest
const version = nextVersion(manifest.version, bump)
manifest.version = version
writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`)

const cargo = readFileSync(cargoPath, 'utf8')
const packageVersion = /(\[package\][\s\S]*?^version = ")[^"]+("$)/m
if (!packageVersion.test(cargo)) {
  throw new Error('Cargo.toml has no package version')
}
writeFileSync(cargoPath, cargo.replace(packageVersion, `$1${version}$2`))

console.log(version)
