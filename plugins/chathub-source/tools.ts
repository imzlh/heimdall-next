// ChatHub picks the answering engine through its `tone` argument. Only the
// values the model-selection menu actually enumerates are honored; an unknown
// tone silently falls back to `Magic` (auto) upstream, which is why a stale
// mapping produced answers with no reasoning under the wrong label.
//
// Two models are exposed: `auto` (→ `Magic`, Copilot decides how long to think)
// and `gpt-5.6-sol`, whose engine is chosen from the request's thinking level —
// "快速/low" answers fast (`Gpt_5_6_Chat`), medium/high (and unset → medium
// default) think (`Gpt_5_6_Reasoning`, the engine that emits chain-of-thought).
// `Gpt_5_6_Chat` follows the observed `Gpt_5_5_Chat` naming (SPEC §6.1 [F16]).
const FIXED_TONE: Record<string, string> = {
    // Generic picker modes (menu section 1).
    "auto": "Magic", // 自动
    "magic": "Magic",
    "chat": "Chat", // 快速响应
    "reasoning": "Reasoning", // 深度思考
    // Explicit GPT 5.6 engines (level-independent).
    "gpt-5.6-reasoning": "Gpt_5_6_Reasoning",
    "gpt-5.6-think": "Gpt_5_6_Reasoning",
    "gpt-5.6-chat": "Gpt_5_6_Chat",
    "gpt-5.6-quick": "Gpt_5_6_Chat",
    // Legacy ids kept working so an existing channel does not degrade to Magic.
    "gpt-5.5": "Gpt_5_5_Chat",
    "gpt-5.5-chat": "Gpt_5_5_Chat",
    "gpt-5.5-reasoning": "Gpt_5_6_Reasoning",
    "claude-sonnet-reasoning": "Gpt_5_6_Reasoning",
};

// Smart ids whose engine follows the thinking level rather than being fixed.
const LEVEL_DRIVEN = new Set(["gpt-5.6-sol", "gpt-5.6"]);

export function toneForModel(
    model: string | undefined,
    reasoningEffort?: string,
): string {
    const id = (model ?? "").trim().toLowerCase();
    if (LEVEL_DRIVEN.has(id)) {
        // Only an explicit "快速/low" opts out of reasoning; medium/high and an
        // unset level (UI default is medium) think.
        return (reasoningEffort ?? "medium").trim().toLowerCase() === "low"
            ? "Gpt_5_6_Chat"
            : "Gpt_5_6_Reasoning";
    }
    // The default's casing is a protocol fact: capital `Magic`, not `magic`.
    return FIXED_TONE[id] ?? "Magic";
}

// ---------------------------------------------------------------------------
// Conversation flattening (OpenAI messages → one ChatHub text)
// ---------------------------------------------------------------------------

function contentToText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content.map((part) => {
            if (typeof part === "string") return part;
            if (part && typeof part === "object") {
                return String((part as { text?: unknown }).text ?? "");
            }
            return "";
        }).join("");
    }
    if (content === null || content === undefined) return "";
    return JSON.stringify(content);
}

/** Long tool outputs are compacted head+tail so context stays readable. */
export function compactToolResult(text: string, limit = 4000): string {
    const value = text.trim();
    if (value.length <= limit) return value;
    const head = Math.floor(limit / 3);
    const tail = Math.max(limit - head - 80, 80);
    return `${value.slice(0, head)}\n... [truncated ${
        value.length - head - tail
    } bytes] ...\n${value.slice(value.length - tail)}`;
}

interface OaiToolCallShape {
    id?: unknown;
    type?: unknown;
    function?: { name?: unknown; arguments?: unknown };
}

/**
 * Flatten the whole OpenAI message list into a single ChatHub turn. ChatHub is
 * a chat surface without OpenAI's structured history, so tool calls travel as
 * labelled text blocks — the same convention the tool-call detection below
 * understands on the way back.
 */
export function flattenConversation(messages: unknown[]): string {
    const system: string[] = [];
    const rest: Record<string, unknown>[] = [];
    for (const message of messages) {
        if (!message || typeof message !== "object" || Array.isArray(message)) {
            continue;
        }
        const record = message as Record<string, unknown>;
        const role = String(record.role ?? "user").toLowerCase();
        if (role === "system" || role === "developer") {
            const text = contentToText(record.content).trim();
            if (text) system.push(text);
        } else {
            rest.push(record);
        }
    }
    let out = "";
    if (system.length > 0) out += `\n[system]\n${system.join("\n")}\n`;
    for (const record of rest) {
        let role = String(record.role ?? "user").toLowerCase() || "user";
        if (role !== "user" && role !== "assistant" && role !== "tool") {
            role = "user";
        }
        let text = contentToText(record.content).trim();
        const toolCalls = Array.isArray(record.tool_calls)
            ? record.tool_calls
            : [];
        if (role === "tool") {
            text = compactToolResult(text);
            out += `\n[tool result id=${
                String(record.tool_call_id ?? "")
            }]\n${text}\n`;
            continue;
        }
        if (toolCalls.length > 0) {
            if (text) out += `\n[${role}]\n${text}\n`;
            out += `\n[${role} tool_calls]\n${JSON.stringify(toolCalls)}\n`;
            continue;
        }
        if (!text) continue;
        out += `\n[${role}]\n${text}\n`;
    }
    return out.trim();
}

// ---------------------------------------------------------------------------
// Content-policy block detection
// ---------------------------------------------------------------------------

/**
 * M365 Copilot returns a short canned refusal when its content filter blocks a
 * turn — e.g. "Hmm...it looks like I can't chat about this. Let's try a
 * different topic.", the "Sorry, ...can't respond to this..." variant, or an
 * apology form (both straight and curly apostrophes, and the Chinese wording).
 * The refusal arrives as an ordinary bot message, so the only way to tell it
 * apart from a real answer is by text.
 */
const CONTENT_BLOCK_PATTERNS: readonly RegExp[] = [
    /it looks like i can.?t (chat about|respond to) this/i,
    /let.?s try a different topic/i,
    /i.?m sorry,? i can.?t respond/i,
    /i apologize,? i cannot/i,
    /(很)?抱歉，我无法/,
];

/** True when `text` is a Copilot content-policy refusal rather than an answer. */
export function isContentPolicyBlock(text: string | undefined): boolean {
    if (!text) return false;
    const value = text.trim();
    // The block is always a short canned message; a long reply that merely
    // mentions "a different topic" is a real answer, not a refusal.
    if (value.length === 0 || value.length > 100) return false;
    return CONTENT_BLOCK_PATTERNS.some((pattern) => pattern.test(value));
}

/** Raised when the upstream refuses a turn on content policy. */
export class ChatHubContentFilterError extends Error {
    constructor(message = "ChatHub blocked the turn on content policy") {
        super(message);
        this.name = "ChatHubContentFilterError";
    }
}

// ---------------------------------------------------------------------------
// Tool protocol: text router (the reference gateway's default strategy)
// ---------------------------------------------------------------------------

interface OaiTool {
    type?: unknown;
    function?: { name?: unknown; description?: unknown; parameters?: unknown };
}

function toolFunctionOf(
    name: string,
    tools: OaiTool[],
): OaiTool["function"] | undefined {
    return tools.find((tool) => tool?.function?.name === name)?.function;
}

export function toolChoiceAllows(choice: unknown, name: string): boolean {
    if (choice === null || choice === undefined) return true;
    if (typeof choice === "string") return choice !== "none";
    if (typeof choice === "object") {
        const record = choice as Record<string, unknown>;
        const fn = record.function;
        if (fn && typeof fn === "object") {
            return String((fn as Record<string, unknown>).name ?? "") === name;
        }
        if (typeof record.name === "string") return record.name === name;
    }
    return true;
}

/** Minimal JSON-Schema subset check (enum/type/required/properties/items). */
export function jsonSchemaError(
    value: unknown,
    schema: Record<string, unknown>,
    path: string,
): string | null {
    const schemaRecord = schema && typeof schema === "object" ? schema : {};
    if (Array.isArray(schemaRecord.enum) && schemaRecord.enum.length > 0) {
        const matched = schemaRecord.enum.some((entry) =>
            JSON.stringify(entry) === JSON.stringify(value)
        );
        if (!matched) return `${path} is not an allowed enum value`;
    }
    const type = typeof schemaRecord.type === "string"
        ? schemaRecord.type
        : undefined;
    switch (type) {
        case "object": {
            if (!value || typeof value !== "object" || Array.isArray(value)) {
                return `${path} must be object`;
            }
            const record = value as Record<string, unknown>;
            if (Array.isArray(schemaRecord.required)) {
                for (const raw of schemaRecord.required) {
                    const name = String(raw);
                    if (!(name in record)) {
                        return `missing required argument ${
                            path === "" ? "" : path + "."
                        }${name}`;
                    }
                }
            }
            const properties = (schemaRecord.properties &&
                    typeof schemaRecord.properties === "object"
                ? schemaRecord.properties
                : {}) as Record<string, Record<string, unknown>>;
            if (schemaRecord.additionalProperties === false) {
                for (const name of Object.keys(record)) {
                    if (!(name in properties)) {
                        return `${path}.${name} is not allowed`;
                    }
                }
            }
            for (const [name, child] of Object.entries(record)) {
                const childSchema = properties[name];
                if (childSchema) {
                    const error = jsonSchemaError(
                        child,
                        childSchema,
                        path ? `${path}.${name}` : name,
                    );
                    if (error) return error;
                }
            }
            return null;
        }
        case "array": {
            if (!Array.isArray(value)) return `${path} must be array`;
            const items = schemaRecord.items;
            if (items && typeof items === "object") {
                for (const [index, child] of value.entries()) {
                    const error = jsonSchemaError(
                        child,
                        items as Record<string, unknown>,
                        `${path}[${index}]`,
                    );
                    if (error) return error;
                }
            }
            return null;
        }
        case "string":
            return typeof value === "string" ? null : `${path} must be string`;
        case "number":
            return typeof value === "number" && Number.isFinite(value)
                ? null
                : `${path} must be number`;
        case "integer":
            return typeof value === "number" && Number.isFinite(value) &&
                    Number.isInteger(value)
                ? null
                : `${path} must be integer`;
        case "boolean":
            return typeof value === "boolean"
                ? null
                : `${path} must be boolean`;
        case "null":
            return value === null ? null : `${path} must be null`;
        default:
            return null;
    }
}

function schemaValid(
    args: Record<string, unknown>,
    fn: OaiTool["function"],
): string | null {
    const parameters = fn?.parameters;
    if (
        !parameters || typeof parameters !== "object" ||
        Array.isArray(parameters)
    ) return null;
    return jsonSchemaError(
        args,
        parameters as Record<string, unknown>,
        "arguments",
    );
}

export interface DetectedToolCall {
    id: string;
    type: string;
    name: string;
    /** Arguments serialized as a JSON object string. */
    arguments: string;
}

function callId(): string {
    return "call_" + crypto.randomUUID().replace(/-/g, "");
}

function toolTypeOf(name: string, tools: OaiTool[]): string {
    const fn = toolFunctionOf(name, tools);
    if (!fn) return "function";
    const tool = tools.find((candidate) => candidate?.function === fn);
    return typeof tool?.type === "string" && tool.type ? tool.type : "function";
}

/**
 * Final trust boundary before a model-generated call reaches the client: an
 * undeclared name, a tool_choice conflict, or schema-invalid arguments never
 * escape to the local tool runner.
 */
export function validateToolCalls(
    calls: DetectedToolCall[],
    tools: OaiTool[],
    choice: unknown,
): DetectedToolCall[] {
    const valid: DetectedToolCall[] = [];
    for (const call of calls) {
        const fn = toolFunctionOf(call.name, tools);
        if (!fn) continue;
        if (!toolChoiceAllows(choice, call.name)) continue;
        let args: Record<string, unknown>;
        try {
            const parsed: unknown = JSON.parse(call.arguments || "{}");
            if (
                !parsed || typeof parsed !== "object" || Array.isArray(parsed)
            ) continue;
            args = parsed as Record<string, unknown>;
        } catch {
            continue;
        }
        if (schemaValid(args, fn) !== null) continue;
        valid.push({
            id: call.id || callId(),
            type: call.type || toolTypeOf(call.name, tools),
            name: call.name,
            arguments: JSON.stringify(args),
        });
    }
    return valid;
}

// ---------------------------------------------------------------------------
// Tool router: one text turn decides CALL_TOOL vs NO_TOOL_NEEDED
// ---------------------------------------------------------------------------

/** OpenAI tool_choice reduced to the router prompt's MODE line. */
export function toolChoiceMode(choice: unknown): string {
    if (choice === null || choice === undefined) return "auto";
    if (typeof choice === "string") return choice;
    if (typeof choice === "object") {
        const record = choice as Record<string, unknown>;
        const fn = record.function as { name?: unknown } | undefined;
        if (record.type === "function" && fn && typeof fn.name === "string") {
            return fn.name;
        }
        if (typeof record.name === "string") return record.name;
    }
    return "auto";
}

/**
 * The router turn is plain text generation: the model role-plays a dispatcher
 * and answers CALL_TOOL or NO_TOOL_NEEDED. It needs no upstream plugin
 * support, which the ChatHub surface does not reliably provide for
 * caller-declared tools. The rules are deliberately repetitive and absolute —
 * Copilot's persona loves to deny that caller tools exist, and every softening
 * becomes a dropped tool call.
 */
export function modelToolRouterPrompt(
    prompt: string,
    tools: OaiTool[],
    choice: unknown,
): string {
    const defs = JSON.stringify(tools);
    const mode = toolChoiceMode(choice);
    let rules =
        `1. If any tool should run next, output exactly one line and nothing else: CALL_TOOL: tool_name({"arg1":"value1"})
2. If no tool should run next, output exactly: NO_TOOL_NEEDED
3. The listed tools are REAL, ACTIVE, and CALLABLE on the caller's machine right now. Never claim they are unavailable, never apologize, never explain tool availability.
4. Only use tools from the list above. Never invent tools. Never add prose before or after your decision line.
5. Arguments must be a valid JSON object that validates against the tool's JSON schema.
6. TOOL-FIRST: whenever a listed tool can accomplish, verify, or make progress on the request, you MUST call it (CALL_TOOL) rather than answer from your own knowledge. The ONLY need you may satisfy without a tool is open web/knowledge search, which the assistant performs natively — for a pure search request with no matching tool, output NO_TOOL_NEEDED. Answering directly when a suitable tool exists is a failure.
7. MODE ${
            mode === "required"
                ? "means a tool call is MANDATORY: you must output a CALL_TOOL line."
                : mode === "auto"
                ? "means you decide, but rule 6 stands: pick a tool whenever one fits, and reserve NO_TOOL_NEEDED for pure conversation or a plain web search."
                : `means only the "${mode}" tool may be selected.`
        }`;
    // Multi-turn: tool_results blocks in the flattened history are results the
    // caller already executed; re-invoking them would duplicate work.
    if (
        prompt.includes("[assistant tool_calls]") ||
        prompt.includes("[tool result id=")
    ) {
        rules += `
8. [assistant tool_calls] and [tool result id=...] rows are ALREADY-EXECUTED history: never re-invoke them, and treat the tool results as ground truth data you already have
9. Only start a NEW tool call when fresh unfinished work remains on the current request`;
    }
    return `You are the tool-routing controller of an automated agent. Decide the next action for the request below.

Available tools (JSON schema): ${defs}

MODE: ${mode}

STRICT RULES:
${rules}

User request and evidence:
${prompt}`;
}

/**
 * Parse the router's decision: the natural-language CALL_TOOL form first,
 * then a NO_TOOL_NEEDED marker, then a JSON {"calls":[…]} envelope. Returns
 * parsed=false when the output is unusable so the caller can run a repair
 * round.
 */
export function parseModelToolDecision(
    text: string,
    tools: OaiTool[],
    choice: unknown,
): { calls: DetectedToolCall[]; parsed: boolean } {
    // Models love wrapping decisions in code fences or prose; peel the layers
    // before matching so a valid decision is never dropped as unparsable.
    let candidate = text.trim();
    const fence = candidate.indexOf("```");
    if (fence >= 0) {
        candidate = candidate.slice(fence + 3).split("```")[0]!.trim();
        if (candidate.toLowerCase().startsWith("json")) {
            candidate = candidate.slice(4).trim();
        }
    }
    const callToolMatch = candidate.match(/CALL_TOOL:\s*([\s\S]+)$/i);
    if (callToolMatch) {
        const rest = callToolMatch[1]!.trim();
        const start = rest.indexOf("(");
        const end = rest.lastIndexOf(")");
        if (start > 0 && end > start) {
            const name = rest.slice(0, start).trim();
            const argsText = rest.slice(start + 1, end);
            try {
                const args: unknown = JSON.parse(argsText);
                if (
                    args && typeof args === "object" && !Array.isArray(args) &&
                    toolChoiceAllows(choice, name)
                ) {
                    const fn = toolFunctionOf(name, tools);
                    if (
                        fn &&
                        schemaValid(args as Record<string, unknown>, fn) ===
                            null
                    ) {
                        return {
                            calls: [{
                                id: callId(),
                                type: toolTypeOf(name, tools),
                                name,
                                arguments: JSON.stringify(args),
                            }],
                            parsed: true,
                        };
                    }
                }
            } catch { /* fall through to the envelope probe */ }
        }
    }
    if (/NO[_\s-]?TOOL[_\s-]?NEEDED/i.test(candidate)) {
        return { calls: [], parsed: true };
    }
    // Fallback: a JSON envelope, optionally labelled ```json … ```.
    let envelopeText = text.trim();
    const envelopeFence = envelopeText.indexOf("```");
    if (envelopeFence >= 0) {
        envelopeText = envelopeText.slice(envelopeFence + 3).split("```")[0]!
            .trim();
        if (envelopeText.toLowerCase().startsWith("json")) {
            envelopeText = envelopeText.slice(4).trim();
        }
    } else if (callToolMatch) {
        // A CALL_TOOL line that failed schema/name validation must not be
        // re-read as an envelope by accident, but plain prose without fences is
        // still probed for a {"calls":[…]} payload.
        envelopeText = candidate;
    }
    const start = envelopeText.indexOf("{");
    const end = envelopeText.lastIndexOf("}");
    if (start < 0 || end <= start) return { calls: [], parsed: false };
    const json = envelopeText.slice(start, end + 1);
    let probe: unknown;
    try {
        probe = JSON.parse(json);
    } catch {
        return { calls: [], parsed: false };
    }
    if (
        !probe || typeof probe !== "object" ||
        !("calls" in (probe as Record<string, unknown>))
    ) {
        return { calls: [], parsed: false };
    }
    const envelope = probe as { calls?: unknown };
    if (!Array.isArray(envelope.calls)) return { calls: [], parsed: false };
    const calls: DetectedToolCall[] = [];
    for (const item of envelope.calls) {
        if (!item || typeof item !== "object" || Array.isArray(item)) continue;
        const record = item as Record<string, unknown>;
        const name = typeof record.name === "string" ? record.name : "";
        const args = record.arguments;
        const fn = toolFunctionOf(name, tools);
        if (
            !fn || args === null || args === undefined ||
            !toolChoiceAllows(choice, name)
        ) continue;
        if (typeof args !== "object" || Array.isArray(args)) continue;
        if (schemaValid(args as Record<string, unknown>, fn) !== null) continue;
        calls.push({
            id: callId(),
            type: toolTypeOf(name, tools),
            name,
            arguments: JSON.stringify(args),
        });
    }
    return { calls, parsed: true };
}

// ---------------------------------------------------------------------------
// OpenAI response shapes
// ---------------------------------------------------------------------------
