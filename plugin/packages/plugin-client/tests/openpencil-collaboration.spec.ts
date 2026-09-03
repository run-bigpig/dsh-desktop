import { describe, expect, it } from 'vitest'
import {
  isPrivateIPv4,
  parseCollaborationJoinCode,
} from '../src/client/openpencil/collaboration.ts'

const TOKEN = 'abcdefghijklmnopqrstuvwx'

describe('OpenPencil LAN collaboration join codes', () => {
  it('accepts private network targets and derives the WebSocket endpoint', () => {
    expect(parseCollaborationJoinCode(`openpencil-lan://192.168.1.20:43123/${TOKEN}`)).toEqual({
      socketURL: `ws://192.168.1.20:43123/openpencil-collab/${TOKEN}`,
      roomToken: TOKEN,
      joinCode: `openpencil-lan://192.168.1.20:43123/${TOKEN}`,
    })
  })

  it('rejects public, malformed, or parameterized targets', () => {
    expect(parseCollaborationJoinCode(`openpencil-lan://8.8.8.8:43123/${TOKEN}`)).toBeNull()
    expect(parseCollaborationJoinCode(`openpencil-lan://192.168.1.20:43123/${TOKEN}?remote=1`)).toBeNull()
    expect(parseCollaborationJoinCode('https://app.openpencil.dev/share/room')).toBeNull()
  })

  it('recognizes only private IPv4 ranges', () => {
    for (const address of ['10.2.3.4', '172.16.0.1', '192.168.5.6', '100.64.1.2', '169.254.3.4', '127.0.0.1']) {
      expect(isPrivateIPv4(address)).toBe(true)
    }
    for (const address of ['8.8.8.8', '172.32.0.1', '100.128.0.1', 'not-an-ip']) {
      expect(isPrivateIPv4(address)).toBe(false)
    }
  })
})
