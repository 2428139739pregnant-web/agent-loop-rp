/**
 * Tool registry placeholder.
 *
 * The current skeleton uses prompt + JSON parsing for 2.1 / 2.2. A future
 * iteration will expose `ToolDefinition`s here so those agents can call the
 * worldbook / context processor as native LLM tools instead of mock JSON.
 */

export interface ToolDefinition {
  readonly name: string
  readonly description: string
}

/** A no-op registry. Kept as a single seam for future tool calling. */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool)
  }

  list(): readonly ToolDefinition[] {
    return [...this.tools.values()]
  }
}
