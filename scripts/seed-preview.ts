/** One-off demo seed for the preview instance (data-preview/requests.sqlite3). */
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync("data-preview/requests.sqlite3");
const models = [
    ["gpt-5.2", "generation.create", "heimdall.protocol.openai"],
    ["gpt-5-mini", "generation.create", "heimdall.protocol.openai"],
    ["claude-sonnet-4-5", "generation.create", "heimdall.protocol.anthropic"],
    ["text-embedding-3-small", "embedding.create", "heimdall.protocol.openai"],
] as const;
const perDay = [8, 5, 6, 4, 3, 5, 4];
let seed = 42;
const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
};
const insert = db.prepare(
    `INSERT OR IGNORE INTO requests (
        request_id, operation, model, protocol_plugin_id, upstream_plugin_id,
        received_at, status, completed_at, request_json
     ) VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, '{}')`,
);
const putUsage = db.prepare(
    `INSERT OR IGNORE INTO usage_records (
        request_id, input_tokens, output_tokens, total_tokens, updated_at
     ) VALUES (?, ?, ?, ?, ?)`,
);
for (const [day, count] of perDay.entries()) {
    const base = new Date();
    base.setDate(base.getDate() - day);
    for (let i = 0; i < count; i++) {
        const [model, operation, protocol] = models[
            Math.floor(rand() * models.length)
        ]!;
        const at = new Date(base);
        at.setHours(8 + Math.floor(rand() * 12), Math.floor(rand() * 60));
        const receivedAt = at.toISOString();
        const id = crypto.randomUUID();
        insert.run(
            id,
            operation,
            model,
            protocol,
            protocol === "heimdall.protocol.anthropic"
                ? "heimdall.source.anthropic"
                : "heimdall.source.openai-compatible",
            receivedAt,
            receivedAt,
        );
        const input = 800 + Math.floor(rand() * 6800);
        const output = 200 + Math.floor(rand() * 2600);
        putUsage.run(id, input, output, input + output, receivedAt);
    }
}
db.close();
console.log("seeded");
