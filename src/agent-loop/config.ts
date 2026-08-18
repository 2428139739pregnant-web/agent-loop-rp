/** Environment-driven configuration for the agent loop. */

const DEFAULT_MODEL = 'deepseek-chat'
const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'
const DEFAULT_TEMPERATURE = 0.7
const TURN_THRESHOLD = 10

export interface AgentLoopConfig {
  apiKey: string | undefined
  baseUrl: string
  model: string
  temperature: number
  turnThreshold: number
}

/**
 * Read agent-loop configuration from environment variables.
 *
 * Missing `DEEPSEEK_API_KEY` is not an error: callers using `MockProvider`
 * don't need it. We emit a stderr warning so the omission is visible.
 */
export function readConfig(env: NodeJS.ProcessEnv = process.env): AgentLoopConfig {
  const apiKey = env.DEEPSEEK_API_KEY?.trim() || undefined
  const baseUrl = env.DEEPSEEK_BASE_URL?.trim() || DEFAULT_BASE_URL
  const model = env.AGENT_LOOP_MODEL?.trim() || DEFAULT_MODEL
  const temperatureRaw = env.AGENT_LOOP_TEMPERATURE?.trim()
  const temperature = temperatureRaw === undefined || temperatureRaw === ''
    ? DEFAULT_TEMPERATURE
    : Number.parseFloat(temperatureRaw)
  if (apiKey === undefined) {
    process.stderr.write(
      '[agent-loop] DEEPSEEK_API_KEY is not set; configure it to use DeepSeekProvider.\n',
    )
  }
  return {
    apiKey,
    baseUrl,
    model,
    temperature: Number.isFinite(temperature) ? temperature : DEFAULT_TEMPERATURE,
    turnThreshold: TURN_THRESHOLD,
  }
}
