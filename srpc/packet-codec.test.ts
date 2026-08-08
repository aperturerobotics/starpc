import { describe, expect, it } from 'vitest'
import vectors from '../testdata/packet-codec-vectors.json'
import { Packet } from './rpcproto.pb.js'
import {
  decodePacketSource,
  encodePacketSource,
  lengthPrefixDecode,
  prependLengthPrefixTransform,
  uint32LEDecode,
} from './packet.js'

const bytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16))
const hex = (
  data: Uint8Array | { subarray: (start?: number, end?: number) => Uint8Array },
) => Buffer.from(data.subarray()).toString('hex')
const collect = async <T>(source: AsyncIterable<T> | Iterable<T>) => {
  const out: T[] = []
  for await (const value of source) out.push(value)
  return out
}

type ValidVector = (typeof vectors.cases)[number] & {
  packet_hex: string
  frame_hex: string
}
const validCases: ValidVector[] = vectors.cases.filter(
  (entry): entry is ValidVector => Boolean(entry.packet_hex && entry.frame_hex),
)

describe('packet codec golden vectors', () => {
  it.each(validCases)(
    '$name has exact protobuf and frame bytes',
    async (entry) => {
      const packet = Packet.fromBinary(bytes(entry.packet_hex))
      const encoded = (
        await collect(
          encodePacketSource(
            (async function* () {
              yield packet
            })(),
          ),
        )
      )[0]
      expect(hex(encoded)).toBe(entry.packet_hex)

      const framed = (
        await collect(
          prependLengthPrefixTransform()(
            (async function* () {
              yield encoded
            })(),
          ),
        )
      )[0]
      expect(hex(framed)).toBe(entry.frame_hex)
    },
  )

  it('rejects zero and oversized encoded chunks', async () => {
    const zero = (async function* () {
      yield new Uint8Array()
    })()
    await expect(collect(prependLengthPrefixTransform()(zero))).rejects.toThrow(
      'invalid packet length',
    )
    const oversized = (async function* () {
      yield new Uint8Array(10_000_001)
    })()
    await expect(
      collect(prependLengthPrefixTransform()(oversized)),
    ).rejects.toThrow('invalid packet length')
  })

  it('rejects zero and oversized lengths, and truncated bodies', async () => {
    const zero = (async function* () {
      yield bytes('00000000')
    })()
    await expect(
      collect(lengthPrefixDecode(zero, uint32LEDecode)),
    ).rejects.toThrow('invalid packet length')
    const oversized = (async function* () {
      yield bytes('81969800')
    })()
    await expect(
      collect(lengthPrefixDecode(oversized, uint32LEDecode)),
    ).rejects.toThrow('invalid packet length')
    const truncated = (async function* () {
      yield bytes('040000000a01')
    })()
    await expect(
      collect(lengthPrefixDecode(truncated, uint32LEDecode)),
    ).rejects.toThrow('truncated packet frame')
  })

  it('decodes fragmented and coalesced frames', async () => {
    const frames = validCases.map((entry) => bytes(entry.frame_hex))
    const combined = new Uint8Array(
      frames.reduce((n, frame) => n + frame.length, 0),
    )
    let offset = 0
    for (const frame of frames) {
      combined.set(frame, offset)
      offset += frame.length
    }
    const payloads = await collect(
      lengthPrefixDecode(
        (async function* () {
          yield combined.subarray(0, 3)
          yield combined.subarray(3, 11)
          yield combined.subarray(11)
        })(),
        uint32LEDecode,
      ),
    )
    expect(payloads.map(hex)).toEqual(
      validCases.map((entry) => entry.packet_hex),
    )
    const decoded = await collect(
      decodePacketSource(payloads.map((payload) => payload.slice())),
    )
    expect(decoded).toHaveLength(validCases.length)
  })

  it('rejects malformed protobuf and incomplete frame prefix', async () => {
    const malformed = vectors.cases.find(
      (entry) => entry.name === 'malformed_complete',
    )!
    expect(() =>
      Packet.fromBinary(bytes(malformed.frame_hex!.slice(8))),
    ).toThrow()
    const incomplete = (async function* () {
      yield bytes('010203')
    })()
    await expect(
      collect(lengthPrefixDecode(incomplete, uint32LEDecode)),
    ).rejects.toThrow('truncated packet frame')
  })
})
