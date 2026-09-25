/**
 * Generic bounds for model rounds, tool invocations and conversation history.
 * Plugin-specific I/O limits belong to the corresponding tool plugin.
 */

/** Completions allowed in one turn: the initial reply plus tool-driven rounds. */
export const MAX_TOOL_ROUNDS = 6;
/** Server tool calls honored from a single completion; extras are ignored. */
export const MAX_TOOL_CALLS_PER_ROUND = 4;
/** Argument text longer than this is rejected before a tool runs. */
export const MAX_TOOL_ARGUMENT_CHARS = 32_768;

/** Characters kept from any single tool result handed back to the model. */
export const MAX_TOOL_TEXT_CHARS = 20_000;

/** Most recent messages kept when sending a conversation upstream. */
export const MAX_HISTORY_MESSAGES = 40;
/** Text-character budget for the history window; older messages drop first. */
export const MAX_HISTORY_TEXT_CHARS = 24_000;
