#!/usr/bin/env node
/**
 * Boot the agent-loop UI server.
 *
 * Usage (from project root):
 *   node --experimental-transform-types scripts/agent-loop-server.mjs
 *   node --experimental-transform-types scripts/agent-loop-server.mjs --port 3090
 *   node --experimental-transform-types scripts/agent-loop-server.mjs --mock
 *
 * Then open http://127.0.0.1:3080 (or whatever port you picked) in a browser.
 */

import { startServer } from '../src/agent-loop/ui-server.ts'

const args = process.argv.slice(2)
function readFlag(name, fallback) {
  const idx = args.indexOf(name)
  if (idx < 0 || idx + 1 >= args.length) return fallback
  return args[idx + 1]
}
function hasFlag(name) {
  return args.includes(name)
}

const port = Number.parseInt(readFlag('--port', '3080'), 10) || 3080
const host = readFlag('--host', '127.0.0.1')
const forceMock = hasFlag('--mock')

const server = await startServer({ port, host, forceMock })

const shutdown = async (signal) => {
  process.stderr.write(`\n[ui-server] received ${signal}, shutting down\n`)
  await server.close()
  process.exit(0)
}
process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))
