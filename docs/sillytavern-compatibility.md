# SillyTavern migration compatibility

This reference defines what the Agent RP importer preserves and what it executes. Imported data is untrusted content: preservation supports later export and migration, while execution is restricted to explicitly supported text semantics.

## Character cards

| Input | Import | Runtime behavior |
|---|---:|---|
| Standalone Character Card V1/V2/V3 JSON | Yes | Same card semantics as PNG; original bytes remain a Session attachment and never enter model content |
| Character Card V1 JSON fields in PNG `chara` metadata | Yes | Identity, description, personality, scenario, examples, and `first_mes` |
| Character Card V2 in PNG `chara` metadata | Yes | V1 behavior, alternate greetings, character system prompt, post-history instructions, and character lorebook |
| Character Card V3 in PNG `ccv3` metadata | Yes | V2 behavior, nickname, and V3 lorebook fields in the safe subset |
| PNG containing both `ccv3` and `chara` | Yes | `ccv3` takes precedence |
| Unknown card fields and `extensions` values | Yes | Preserved without entering the prompt unless a supported field owns the behavior |
| Future V3 minor versions | Degraded | Imported and preserved; the result reports that future behavior may be inactive |
| Independent SillyTavern World Info JSON | Yes | Session-owned literal-key safe subset; original JSON and unsupported fields remain exportable |
| Character Card V3 CHARX | Yes | Root `card.json`, original archive, embedded icon, background, emotion/expression images, and other card fields above; unsupported asset types remain preserved but inert |

Card `system_prompt` replaces the fallback identity instruction when non-empty and supports `{{original}}`. `post_history_instructions` is appended after the Agent RP behavioral contract. `{{char}}`, `<char>`, and `<bot>` resolve to the V3 nickname when present, otherwise the card name.

Display-regex output containing a complete HTML document, or a fragment with `<style>`/`<script>`, runs in an isolated light-frontend iframe even when a card labels its Markdown fence as `text` instead of `html`; ordinary fenced markup examples remain inert. The frame has no same-origin access to the host, strips nested browsing contexts and external script tags, and provides small compatibility shims for common ST/MVU lifecycle calls and jQuery-style DOM methods. This keeps reference-card HUDs usable without allowing card code to reach the host page, cookies, storage, or parent DOM. Collapsed greeting choices do not expose frontend source and create the preview frame only after expansion. Character-library World Info bodies are fetched in bounded pages only after the read-only section opens, so selecting a card does not transfer or mount every embedded entry.

## Character lorebooks

Enabled entries support constant activation, literal primary keys, selective secondary keys, case sensitivity, scan depth, insertion order, `before_char` and `after_char` placement, priority, and token budget. Each active entry enters the prompt once.

EJS in an otherwise compatible active entry is rendered before prompt planning/token accounting. The current subset supports `<% %>`, `<%= %>`, `<%- %>`, comments, whitespace slurping, conditions, loops, `print`, character and user names, role-aware recent-message metadata and readers, `variables`, `stat_data`, read-only `getvar` aliases, deterministic JSON-data Lodash helpers, YAML serialization, and bounded reads of plain Session-owned World Info through `getwi` or `getWorldInfo`. Promises that settle entirely inside the isolated runtime may be awaited. The same renderer is used for model-facing character fields and imported preset modules. The agent-loop compatibility lane now supports the common `@INJECT`, `[GENERATE]`, `[RENDER]`, and `@@generate_*`/`@@render_*` placement forms locally; `@INJECT` is deterministic, while `[GENERATE]/[RENDER]` preserve the blue-light/green-light activation rule (`BEFORE` is blue-only and `AFTER` accepts an activated green entry). `[RENDER]` is display-only and does not enter the stored reroll transcript. Host-backed async APIs, includes, variable writes, nested World Info template evaluation, dynamic World Info activation, and complex variable-initialization decorators remain preserved but inactive. The exact matrix is documented in [EJS compatibility](ejs-compatibility.md).

## Independent World Info

SillyTavern World Info JSON with a top-level `entries` object or array is accepted. Enabled entries support constant activation, literal primary and secondary keys, all four `selectiveLogic` modes, case sensitivity, whole-word matching, per-entry scan depth, insertion order, and before/after-character positions. Imported books remain Session-owned and combine with an imported card's embedded lorebook.

Regular-expression keys are routed through the deterministic ST lane; probability is rolled locally after activation; and the common generation/render decorators are routed through the local plugin plan. Vector matching, timed effects, recursive controls, character-field matching, and unsupported insertion positions remain preserved but inert. The importer does not execute a partially supported entry when its unsupported fields would change whether or where it activates.

V3 entries marked for regex matching still activate when every key is equivalent to a literal substring lookup. Keys that require an actual regular-expression engine, recursive scanning, and decorated content are retained but never executed. The import result lists each disabled capability. Each source book keeps its own cap, then every active book shares a player-adjustable Session budget (4096 tokens by default); priority decides which matched entries survive that final cap. `ignoreBudget` can bypass a source-book cap but not the Session safety cap. Token budgeting uses a deterministic local estimate; it does not claim byte-for-byte parity with a SillyTavern model tokenizer.

## Tavern Helper scripts and MVU

Enabled character and preset scripts run in separate browser sandbox frames without same-origin access to the Host. The compatibility runtime provides Session-scoped variables, events, script buttons and metadata, display-message refresh, regex and script-tree readers and writers, World Info access, prompt injection, popup and storage bridges, and approval-gated generation APIs. Script failures are isolated and reported by script name without copying source into diagnostics.

Classic scripts execute directly. ESM keeps its original module boundaries and may use static imports or literal dynamic imports with complete HTTPS URLs from built-in or player-approved origins. Non-literal, relative, bare, non-HTTPS, oversized, and unapproved root imports fail before execution. Network fetch, images, frames, same-origin access, and parent-page DOM access remain disabled inside the sandbox; module loading is restricted by the frame's script policy.

MVU initialization recognizes both `<initvar>` content and ordered `[initvar]` lorebook entries. The Host provides the public `Mvu` variable read and replacement APIs and canonical lifecycle events, and persists listener changes made during initialization or completed updates. A public MagVarUpdate bundle imported only for its side effects is replaced by this Host capability; its SillyTavern settings panel and parent-page UI are not mounted. The common MVU-Zod path receives fixed YAML and Zod browser modules when its inspected dependency source requires those globals.

## Character-card Regex and HTML display

The importer preserves the common ST `regex_scripts` fields: `scriptName`, `findRegex`, `replaceString`, `trimStrings`, `placement`, `disabled`, `markdownOnly`, `promptOnly`, `runOnEdit`, `substituteRegex`, `minDepth`, and `maxDepth`. The runtime uses the character name/nickname and active persona name for the usual `{{char}}`/`{{user}}` macros, honors user-input and AI-output placements, and executes the normal pass before the display/prompt-specific pass. Display rules are applied only at render time; prompt rules are applied to the model-facing copy, so the stored transcript and reroll source remain unmodified.

When a display rule produces a complete HTML document or a fragment containing a stylesheet/script, the UI mounts it in a sandboxed iframe that spans the conversation width. Markdown remains native Markdown, and ordinary fenced examples remain code/text rather than executable HTML. The sandbox strips external script tags and nested frames, does not grant same-origin access, and exposes only small compatibility shims needed by common ST/MVU HUDs. This is intentionally a compatible safe subset, not arbitrary parent-page extension execution.

## Security and degradation

The importer never executes lorebook regular expressions, decorators, unknown extension code, or unsupported assets. Tavern Helper execution is limited to the isolated runtime above. The supported EJS subset runs in a fresh QuickJS context with bounded memory, stack, interpreter work, source, output, and evaluations per prompt pass; Node globals, modules, files, network APIs, wall-clock time, and randomness are not exposed. A template failure excludes only that prompt module or lorebook entry and reports a stable category without copying private source into diagnostics. Imported replacement rules run only in Agent RP's isolated text pipeline: display rules transform rendered message text, while prompt rules transform the model-facing copy without changing the stored transcript. Remote and data-URL assets are neither fetched nor decoded. CHARX indexes declared embedded PNG, JPEG, WebP, GIF, and AVIF images while keeping their payloads compressed until one image is requested; code, audio, video, models, fonts, and unknown asset types remain inside the preserved archive and are not executed. Asset records, group-only greetings, and unknown extensions remain in preserved raw JSON. Standalone JSON must be a `.json` file containing valid UTF-8; the Host stores it as an opaque attachment, so neither its bytes nor its path are sent to the model. A complete PNG, JSON, or CHARX transport is limited to 64 MiB, while its decoded card definition is limited separately to 8 MiB; embedded CHARX media does not consume the definition allowance. One CHARX may contain at most 4096 entries and expand to at most 128 MiB.

## Public format sources

The implementation is independent and follows public interoperability formats rather than copying SillyTavern implementation code:

- [Character Card V2 specification](https://github.com/malfoyslastname/character-card-spec-v2), reviewed at `8083fb388615ccbce768e97cbbd49d2b3214632c`
- [Character Card V3 specification](https://github.com/kwaroran/character-card-spec-v3), reviewed at `f3a86af019fbd99f788f7a1155f399655b34ab35`
- [SillyTavern](https://github.com/SillyTavern/SillyTavern) observable PNG and chat formats, reviewed at `8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8`

PNG chunk extraction uses the MIT-licensed `png-chunks-extract` package. The MIT-licensed `png-chunk-text` encoder is retained only for generated test fixtures. No SillyTavern AGPL source is included.

Isolated EJS evaluation uses the MIT-licensed `quickjs-emscripten-core` and the embedded release-sync QuickJS variant. The implementation is based on public EJS syntax and observable interoperability behavior; no AGPL template-extension source is included.

ESM import inspection uses the MIT-licensed `es-module-lexer`. Public MagVarUpdate and MVU-Zod behavior is implemented against their documented globals and events; their source is not included in this package.
