import { afterEach, describe, expect, it, vi } from 'vitest'

import { githubIdentityToken, npmPublishToken } from './release-publish.js'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('release publish OIDC', () => {
  it('requests a GitHub identity token for the npm registry', async () => {
    vi.stubEnv('NPM_ID_TOKEN', '')
    vi.stubEnv(
      'ACTIONS_ID_TOKEN_REQUEST_URL',
      'https://github.example/token?job=1',
    )
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'request-token')
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ value: 'identity-token' })),
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(githubIdentityToken()).resolves.toBe('identity-token')
    const [request, init] = fetchMock.mock.calls[0]
    expect(String(request)).toContain('audience=npm%3Aregistry.npmjs.org')
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer request-token',
    )
  })

  it('exchanges the identity token for a short-lived publish token', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ token: 'publish-token' })),
      )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      npmPublishToken('@aptre/starpc', 'identity-token'),
    ).resolves.toBe('publish-token')
    const [request, init] = fetchMock.mock.calls[0]
    expect(String(request)).toBe(
      'https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/%40aptre%2Fstarpc',
    )
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('Authorization')).toBe(
      'Bearer identity-token',
    )
  })

  it('encodes every package path separator', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ token: 'publish-token' })),
      )
    vi.stubGlobal('fetch', fetchMock)

    await npmPublishToken('@aptre/starpc/extra', 'identity-token')
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://registry.npmjs.org/-/npm/v1/oidc/token/exchange/package/%40aptre%2Fstarpc%2Fextra',
    )
  })

  it('rejects a missing GitHub OIDC grant before publishing', async () => {
    vi.stubEnv('NPM_ID_TOKEN', '')
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_URL', '')
    vi.stubEnv('ACTIONS_ID_TOKEN_REQUEST_TOKEN', '')

    await expect(githubIdentityToken()).rejects.toThrow('id-token: write')
  })
})
