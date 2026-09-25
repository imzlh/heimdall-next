/** Safe JSON in an inert script element, including plugin-supplied display text. */
export function serializeBoot(value: unknown): string {
    return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(
        ">",
        "\\u003e",
    ).replaceAll("&", "\\u0026").replaceAll("\u2028", "\\u2028").replaceAll(
        "\u2029",
        "\\u2029",
    );
}
