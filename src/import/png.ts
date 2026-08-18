/** Character Card PNG tEXt transport decoder. */

import { Buffer } from 'node:buffer'
import extractChunks from 'png-chunks-extract'
import { assertCharacterCardJsonSize } from './character-card.ts'
import type { CharacterCardPngPayload } from './types.ts'

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

function preflightChunks(data: Uint8Array): void {
  let offset = PNG_SIGNATURE.byteLength
  let ended = false
  while (offset < data.byteLength) {
    if (data.byteLength - offset < 12) throw new Error('character card PNG has a truncated chunk')
    const view = new DataView(data.buffer, data.byteOffset + offset, 4)
    const length = view.getUint32(0)
    const end = offset + 12 + length
    if (!Number.isSafeInteger(end) || end > data.byteLength) throw new Error('character card PNG has an invalid chunk length')
    const name = Buffer.from(data.subarray(offset + 4, offset + 8)).toString('ascii')
    offset = end
    if (name === 'IEND') {
      ended = true
      break
    }
  }
  if (!ended) throw new Error('character card PNG has no IEND chunk')
}

function decodeBase64(value: string, keyword: string): string {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    throw new Error(`${keyword} PNG metadata is not canonical base64`)
  }
  const bytes = Buffer.from(value, 'base64')
  assertCharacterCardJsonSize(bytes.byteLength)
  if (bytes.toString('base64') !== value) throw new Error(`${keyword} PNG metadata is not canonical base64`)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new Error(`${keyword} PNG metadata is not valid UTF-8`, { cause: error })
  }
}

function decodeTextChunk(data: Uint8Array): { readonly keyword: string; readonly text: string } {
  const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  const separator = bytes.indexOf(0)
  if (separator < 0) return { keyword: bytes.toString('latin1'), text: '' }
  if (bytes.indexOf(0, separator + 1) >= 0) {
    throw new Error('Invalid NULL character found. 0x00 character is not permitted in tEXt content')
  }
  return {
    keyword: bytes.subarray(0, separator).toString('latin1'),
    text: bytes.subarray(separator + 1).toString('latin1'),
  }
}

/**
 * Extract the preferred card payload from one verified PNG attachment.
 * @param data - complete PNG bytes read from the attachment store.
 * @returns decoded JSON text, preferring `ccv3` over `chara`.
 */
export function readCharacterCardPng(data: Uint8Array): CharacterCardPngPayload {
  const bytes = Buffer.from(data)
  if (bytes.byteLength < PNG_SIGNATURE.byteLength || !bytes.subarray(0, PNG_SIGNATURE.byteLength).equals(PNG_SIGNATURE)) {
    throw new Error('character card attachment is not a PNG')
  }
  let chunks: ReturnType<typeof extractChunks>
  try {
    preflightChunks(bytes)
    chunks = extractChunks(bytes)
  } catch (error) {
    throw new Error('character card PNG is malformed', { cause: error })
  }
  const payloads = new Map<string, string>()
  for (const chunk of chunks) {
    if (chunk.name !== 'tEXt') continue
    let decoded: ReturnType<typeof decodeTextChunk>
    try {
      decoded = decodeTextChunk(chunk.data)
    } catch (error) {
      throw new Error('character card PNG contains malformed text metadata', { cause: error })
    }
    const keyword = decoded.keyword.toLowerCase()
    if ((keyword === 'ccv3' || keyword === 'chara') && !payloads.has(keyword)) {
      payloads.set(keyword, decoded.text)
    }
  }
  for (const keyword of ['ccv3', 'chara'] as const) {
    const payload = payloads.get(keyword)
    if (payload !== undefined) return { keyword, json: decodeBase64(payload, keyword) }
  }
  throw new Error('PNG does not contain ccv3 or chara character metadata')
}
