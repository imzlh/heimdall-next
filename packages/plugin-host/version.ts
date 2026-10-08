/** SemVer precedence, without converting arbitrary-sized numeric identifiers to floats. */
export function comparePluginVersions(left: string, right: string): number {
    const parse = (version: string) => {
        const match =
            /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
                .exec(version);
        if (
            !match || match[0] !== version ||
            match[4]?.split(".").some((part) => /^0\d+$/.test(part))
        ) {
            throw new TypeError("插件升级需要有效的语义版本号");
        }
        return {
            core: match.slice(1, 4) as string[],
            pre: match[4]?.split("."),
        };
    };
    const a = parse(left);
    const b = parse(right);
    const numeric = (x: string, y: string) =>
        x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
    for (let index = 0; index < 3; index++) {
        const result = numeric(a.core[index]!, b.core[index]!);
        if (result) return result;
    }
    if (!a.pre || !b.pre) return a.pre ? -1 : b.pre ? 1 : 0;
    for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
        const x = a.pre[index];
        const y = b.pre[index];
        if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
        if (x === y) continue;
        const xn = /^\d+$/.test(x);
        const yn = /^\d+$/.test(y);
        return xn && yn ? numeric(x, y) : xn ? -1 : yn ? 1 : x < y ? -1 : 1;
    }
    return 0;
}
