import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CONTROLLED_TRIGGER_SLASH_COMMANDS,
  MAX_WAIT_MILLISECONDS,
  parseSlashCommand,
  parseTriggerSlash,
} from './slash.ts'

function reason(source: string): string {
  const result = parseTriggerSlash(source)
  if (result.status !== 'unsupported' && result.status !== 'invalid') {
    throw new Error(`expected a classified failure for ${source}`)
  }
  return result.reason
}

test('controlled command allowlist is explicit and immutable', () => {
  assert.deepEqual([...CONTROLLED_TRIGGER_SLASH_COMMANDS], ['echo', 'pass', 'wait', 'delay', 'sleep'])
  assert.equal(Object.isFrozen(CONTROLLED_TRIGGER_SLASH_COMMANDS), true)
})

test('/echo returns display data without interpreting HTML', () => {
  assert.deepEqual(parseTriggerSlash('/echo severity=success hello <b>world</b>'), {
    source: '/echo severity=success hello <b>world</b>',
    status: 'supported',
    command: 'echo',
    canonicalCommand: 'echo',
    severity: 'success',
    text: 'hello <b>world</b>',
    output: 'hello <b>world</b>',
  })
  assert.deepEqual(parseSlashCommand('/echo "hello world"'), {
    source: '/echo "hello world"',
    status: 'supported',
    command: 'echo',
    canonicalCommand: 'echo',
    severity: 'info',
    text: 'hello world',
    output: 'hello world',
  })
})

test('/pass preserves a literal pipe value and never resolves macros', () => {
  assert.deepEqual(parseTriggerSlash('/pass hello world'), {
    source: '/pass hello world',
    status: 'supported',
    command: 'pass',
    canonicalCommand: 'pass',
    value: 'hello world',
    output: 'hello world',
  })
  assert.equal(parseTriggerSlash('/pass {{pipe}}').status, 'unsupported')
})

test('/wait, /delay, and /sleep only describe a bounded delay', () => {
  for (const command of ['wait', 'delay', 'sleep']) {
    const result = parseTriggerSlash(`/${command} 250`)
    assert.deepEqual(result, {
      source: `/${command} 250`,
      status: 'supported',
      command,
      canonicalCommand: 'wait',
      delayMs: 250,
      output: '',
    })
  }
  assert.equal(parseTriggerSlash(`/wait ${MAX_WAIT_MILLISECONDS}`).status, 'supported')
})

test('malformed or incomplete allowlisted commands are invalid', () => {
  assert.equal(reason('/echo severity=wat text'), 'invalid-severity')
  assert.equal(reason('/echo "unterminated'), 'malformed-quoting')
  assert.equal(reason('/pass'), 'missing-argument')
  assert.equal(reason('/wait 1.5'), 'invalid-delay')
  assert.equal(reason('/wait 60001'), 'delay-out-of-range')
})

test('pipes are not partially parsed as safe commands', () => {
  const result = parseTriggerSlash('/echo safe | /javascript alert(1)')
  assert.deepEqual(result, {
    source: '/echo safe | /javascript alert(1)',
    status: 'unsupported',
    command: 'echo',
    reason: 'pipeline',
  })
  assert.equal(parseTriggerSlash('/echo "a|b"').status, 'supported')
})

test('macros, closures, unknown commands, and side effects are explicit unsupported results', () => {
  assert.deepEqual(parseTriggerSlash('/echo {{user}}'), {
    source: '/echo {{user}}',
    status: 'unsupported',
    command: 'echo',
    reason: 'macro-resolution-required',
  })
  assert.equal(reason('/run something'), 'side-effect-command')
  assert.equal(reason('/javascript return 1'), 'side-effect-command')
  assert.equal(reason('/if left=1 right=1'), 'unknown-command')
  assert.equal(reason('/echo {: /javascript x :}'), 'closure')
})

test('non-commands and empty input are not execution requests', () => {
  assert.deepEqual(parseTriggerSlash('   '), { source: '   ', status: 'empty' })
  assert.equal(reason('hello'), 'not-a-command')
  assert.equal(reason('/'), 'empty-command')
})
