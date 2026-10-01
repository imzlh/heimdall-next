import { assertEquals } from "@std/assert";

const projectRoot = new URL("../", import.meta.url);
const webRoot = "src/web";
const clientRoot = `${webRoot}/client`;
const sharedRoot = `${webRoot}/shared`;
const ignoredDirectories = new Set([
    ".deno",
    ".git",
    ".migration-backups", // Reversible archives are outside the runtime tree.
    "coverage",
    "data",
    "dist",
    "node_modules",
    "public", // Generated browser bundles are checked by build:web.
]);
const sourceExtension = /\.(?:[cm]?[jt]sx?|vue)$/;
const targetDirectories = [
    "src/http",
    "src/composition",
    `${webRoot}/components`,
    `${webRoot}/pages`,
    clientRoot,
    "packages/admin-contracts",
    "packages/contracts",
    "packages/source-sdk",
    "packages/hip",
    "packages/kernel",
    "packages/plugin-host",
    "packages/storage",
    "plugins",
    "tests",
];
const serverConfig = JSON.parse(
    await Deno.readTextFile(new URL("deno.json", projectRoot)),
);
const browserConfig = JSON.parse(
    await Deno.readTextFile(new URL("deno.browser.json", projectRoot)),
);

interface ModuleImport {
    specifier: string;
    typeOnly: boolean;
}

async function exists(relativePath: string): Promise<boolean> {
    try {
        await Deno.stat(new URL(relativePath, projectRoot));
        return true;
    } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
    }
}

async function filesUnder(directory: string): Promise<string[]> {
    if (!(await exists(directory))) return [];
    const files: string[] = [];
    for await (const entry of Deno.readDir(new URL(directory, projectRoot))) {
        if (entry.isDirectory && ignoredDirectories.has(entry.name)) continue;
        const path = `${directory}/${entry.name}`.replace(/^\.\//, "");
        if (entry.isDirectory) {
            files.push(...await filesUnder(path));
        } else if (entry.isFile && sourceExtension.test(entry.name)) {
            files.push(path);
        }
    }
    return files;
}

function resolveRelative(importer: string, specifier: string): string {
    const segments = importer.replaceAll("\\", "/").split("/");
    segments.pop();
    for (const segment of specifier.replaceAll("\\", "/").split("/")) {
        if (!segment || segment === ".") continue;
        if (segment === "..") segments.pop();
        else segments.push(segment);
    }
    return segments.join("/");
}

function resolveModule(importer: string, specifier: string): string {
    if (specifier.startsWith(".")) return resolveRelative(importer, specifier);
    const importMap: Record<string, string> = isUnder(importer, clientRoot)
        ? browserConfig.imports
        : serverConfig.imports;
    // Resolve configured aliases, including aliases added after this test.
    const alias = Object.keys(importMap).sort((a, b) => b.length - a.length)
        .find((key) =>
            specifier === key ||
            (key.endsWith("/") && specifier.startsWith(key))
        );
    if (!alias) return specifier;
    const mapped = importMap[alias]! + specifier.slice(alias.length);
    return mapped.startsWith(".")
        ? resolveRelative("deno.json", mapped)
        : mapped;
}

function isUnder(path: string, root: string): boolean {
    return path === root || path.startsWith(`${root}/`);
}

function moduleName(specifier: string): string {
    return specifier.replace(/^(?:jsr|npm):/, "")
        .replace(/^https?:\/\/[^/]+\//, "");
}

function isHono(specifier: string): boolean {
    return /^(?:@hono\/hono|hono)(?:@[^/]+)?(?:\/|$)/.test(
        moduleName(specifier),
    );
}

function isHonoJsx(specifier: string): boolean {
    return /^(?:@hono\/hono|hono)(?:@[^/]+)?\/jsx(?:\/|$)/.test(
        moduleName(specifier),
    );
}

/** Plugin UI is a browser entry; domain modules keep the normal inward boundary. */
function isPluginUiEntry(file: string): boolean {
    return /^plugins\/[^/]+\/ui\.tsx$/.test(file);
}

function isHonoDom(specifier: string): boolean {
    return /^(?:@hono\/hono|hono)(?:@[^/]+)?\/jsx\/dom(?:\/|$)/.test(
        moduleName(specifier),
    );
}

function withoutComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
}

function importsFrom(source: string): ModuleImport[] {
    const imports: ModuleImport[] = [];
    // Inspect literal module specifiers in static imports, re-exports, and
    // dynamic imports. Keep type-only DTO edges distinct from runtime edges.
    const code = withoutComments(source);
    const declarations =
        /\b(?:import|export)\s+(type\s+)?(\{[^}]*\}|\*\s*(?:as\s+[\w$]+)?|[\w$]+(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[\w$]+))?)\s+from\s*["']([^"']+)["']/g;
    for (const match of code.matchAll(declarations)) {
        const clause = match[2]!.trim();
        const bindings = clause.startsWith("{")
            ? clause.slice(1, -1).split(",").map((part) => part.trim()).filter(
                Boolean,
            )
            : [];
        imports.push({
            specifier: match[3]!,
            typeOnly: Boolean(match[1]) ||
                (bindings.length > 0 &&
                    bindings.every((binding) => /^type\s+/.test(binding))),
        });
    }
    const runtimeImports = [
        /\bimport\s*["']([^"']+)["']/g,
        /\b(?:import|require)\s*\(\s*["']([^"']+)["']/g,
    ];
    for (const pattern of runtimeImports) {
        for (const match of code.matchAll(pattern)) {
            imports.push({ specifier: match[1]!, typeOnly: false });
        }
    }
    // Automatic JSX runtimes are imports too, even when no import is written.
    for (const match of source.matchAll(/@jsxImportSource\s+(\S+)/g)) {
        imports.push({ specifier: match[1]!, typeOnly: false });
    }
    return imports;
}

async function sourcesUnder(directory: string) {
    return await Promise.all((await filesUnder(directory)).map(async (file) => {
        const source = await Deno.readTextFile(new URL(file, projectRoot));
        const imports = importsFrom(source).map((reference) => ({
            ...reference,
            resolved: resolveModule(file, reference.specifier),
        }));
        return { file, source, imports };
    }));
}

/** The server application is the flattened root: everything under src plus the main entry. */
async function serverSources() {
    const modules = await sourcesUnder("src");
    if (await exists("main.ts")) {
        const source = await Deno.readTextFile(new URL("main.ts", projectRoot));
        modules.push({
            file: "main.ts",
            source,
            imports: importsFrom(source).map((reference) => ({
                ...reference,
                resolved: resolveModule("main.ts", reference.specifier),
            })),
        });
    }
    return modules;
}

Deno.test("architecture: canonical application and package directories exist", async () => {
    const missing = [];
    for (const directory of targetDirectories) {
        if (!(await exists(directory))) missing.push(directory);
    }
    assertEquals(missing, [], "canonical architecture directories are missing");
});

Deno.test("architecture: all TypeScript and JSX tests live under tests", async () => {
    const misplaced = (await filesUnder(".")).filter((file) =>
        /(?:^|[._])(?:test|spec)\.[cm]?[jt]sx?$/.test(
            file.split("/").at(-1)!,
        ) &&
        !isUnder(file, "tests")
    );
    assertEquals(
        misplaced,
        [],
        "test and spec files must be kept under tests/",
    );
});

Deno.test("architecture: browser checking has no Deno or Node ambient types", () => {
    assertEquals(serverConfig.compilerOptions.jsxImportSource, "hono/jsx");
    assertEquals(browserConfig.compilerOptions.jsxImportSource, "hono/jsx/dom");
    const libraries: string[] = browserConfig.compilerOptions.lib ?? [];
    const types: string[] = browserConfig.compilerOptions.types ?? [];
    assertEquals(libraries.includes("dom"), true);
    assertEquals(
        [...libraries, ...types].filter((name) =>
            /(?:^|[/@:])(?:deno|node)(?:[./@:]|$)/i.test(name)
        ),
        [],
        "browser type checks must use browser ambient types",
    );
});

Deno.test("architecture: Hono JSX is the only application UI stack", async () => {
    assertEquals(await exists("apps"), false, "apps/ is retired");
    const violations: string[] = [];
    const groups = [
        await serverSources(),
        await sourcesUnder("packages"),
        await sourcesUnder("plugins"),
        await sourcesUnder("tests"),
    ];
    for (const group of groups) {
        for (const { file, imports } of group) {
            if (file.endsWith(".vue")) violations.push(file);
            for (const { specifier, resolved } of imports) {
                if (
                    /^(?:react|react-dom|vue|vite|@vitejs\/[^/]+)(?:@[^/]+)?(?:\/|$)/
                        .test(moduleName(resolved))
                ) violations.push(`${file} -> ${specifier}`);
            }
        }
    }
    assertEquals(violations, [], "use Hono JSX within src/web");
});

Deno.test("architecture: packages cannot depend on applications, plugins, or Hono", async () => {
    const violations: string[] = [];
    for (const { file, imports } of await sourcesUnder("packages")) {
        for (const { specifier, resolved } of imports) {
            if (
                isUnder(resolved, "src") || resolved === "main.ts" ||
                isUnder(resolved, "plugins") ||
                isHono(resolved)
            ) violations.push(`${file} -> ${specifier}`);
        }
    }
    assertEquals(violations, [], "package dependencies must point inward");
});

Deno.test("architecture: Hono stays in HTTP, web, and plugin browser entries", async () => {
    const violations: string[] = [];
    const groups = [await serverSources(), await sourcesUnder("plugins")];
    for (const group of groups) {
        for (const { file, imports } of group) {
            if (
                isUnder(file, "src/http") || isUnder(file, webRoot)
            ) continue;
            for (const { specifier, resolved } of imports) {
                if (isPluginUiEntry(file) && isHonoDom(resolved)) continue;
                if (isHono(resolved)) {
                    violations.push(`${file} -> ${specifier}`);
                }
            }
        }
    }
    assertEquals(
        violations,
        [],
        "Hono must not enter composition or domain code",
    );
});

Deno.test("architecture: browser and shared UI modules cannot depend on server runtime", async () => {
    const violations: string[] = [];
    for (
        const directory of [clientRoot, sharedRoot, "packages/admin-contracts"]
    ) {
        for (const { file, source, imports } of await sourcesUnder(directory)) {
            for (const { specifier, resolved } of imports) {
                const isClient = isUnder(file, clientRoot);
                const allowed = (isClient && isUnder(resolved, clientRoot)) ||
                    isUnder(resolved, sharedRoot) ||
                    (["npm:marked@15.0.12", "npm:entities@6.0.1"].includes(
                        resolved,
                    ) &&
                        file === `${sharedRoot}/chat-markdown.ts`) ||
                    (file === `${sharedRoot}/icons.tsx` &&
                        resolved === "npm:lucide@1.47.0/dist/esm/lucide.mjs") ||
                    (isClient && isHonoJsx(resolved)) ||
                    // This loop audits every contract module too: constants and
                    // pure validators are safe without a per-file allowlist.
                    isUnder(resolved, "packages/admin-contracts");
                if (!allowed) violations.push(`${file} -> ${specifier}`);
            }
            if (
                /\b(?:Deno|process|Buffer)\s*(?:\.|\[)/.test(
                    withoutComments(source),
                )
            ) violations.push(`${file} -> server runtime global`);
            if (
                !isUnder(file, clientRoot) &&
                /\b(?:window|document|localStorage|sessionStorage)\s*(?:\.|\[)/
                    .test(withoutComments(source))
            ) {
                violations.push(
                    `${file} -> shared code requires browser globals`,
                );
            }
        }
    }
    assertEquals(
        violations,
        [],
        "browser/shared modules use local UI code and browser-safe contracts",
    );
});

Deno.test("architecture: server modules never import browser modules", async () => {
    const violations: string[] = [];
    for (const { file, imports } of await serverSources()) {
        if (isUnder(file, clientRoot)) continue;
        for (const { specifier, resolved } of imports) {
            if (isUnder(resolved, clientRoot)) {
                violations.push(`${file} -> ${specifier}`);
            }
        }
    }
    assertEquals(violations, [], "SSR references the browser bundle by URL");
});

Deno.test("architecture: plugins cannot import host implementation details", async () => {
    const violations: string[] = [];
    const forbiddenRoots = [
        "src",
        "packages/kernel",
        "packages/plugin-host",
        "packages/storage",
        "packages/admin-contracts",
    ];
    for (const { file, imports } of await sourcesUnder("plugins")) {
        for (const { specifier, resolved } of imports) {
            if (
                isPluginUiEntry(file) &&
                [
                    "packages/admin-contracts/preset-ui.ts",
                    "packages/admin-contracts/source-model-map.ts",
                    "packages/admin-contracts/ui.ts",
                ].includes(resolved)
            ) continue;
            // Preset browser entries share decorative icons through the public
            // UI alias; host state, transport, and other UI internals stay private.
            if (
                isPluginUiEntry(file) && specifier === "@heimdall/ui/icons" &&
                resolved === `${sharedRoot}/icons.tsx`
            ) continue;
            if (forbiddenRoots.some((root) => isUnder(resolved, root))) {
                violations.push(`${file} -> ${specifier}`);
            }
        }
    }
    assertEquals(
        violations,
        [],
        "plugins depend on public contracts, optional SDK and own modules",
    );
});

Deno.test("architecture: outbound proxy transports are an optional plugin SDK", async () => {
    const violations: string[] = [];
    for (const { file, imports } of await sourcesUnder("packages/source-sdk")) {
        for (const { specifier, resolved } of imports) {
            if (
                isUnder(resolved, "src") ||
                isUnder(resolved, "plugins") ||
                ["packages/kernel", "packages/plugin-host", "packages/storage"]
                    .some((root) => isUnder(resolved, root))
            ) violations.push(`${file} -> ${specifier}`);
        }
    }
    for (const directory of ["packages/kernel", "src/composition"]) {
        for (const { file, source, imports } of await sourcesUnder(directory)) {
            for (const { specifier, resolved } of imports) {
                if (isUnder(resolved, "packages/source-sdk")) {
                    violations.push(`${file} -> ${specifier}`);
                }
            }
            if (/\bglobalThis\s*\.\s*fetch\s*=/.test(withoutComments(source))) {
                violations.push(`${file} -> global fetch replacement`);
            }
        }
    }
    assertEquals(
        violations,
        [],
        "the host supplies proxy data; plugins choose transports",
    );
});

Deno.test("architecture: chat core has no built-in tool names or provider I/O", async () => {
    const modules = await sourcesUnder("src/chat");
    const route = (await sourcesUnder("src/http")).find((entry) =>
        entry.file === "src/http/chat-routes.ts"
    );
    if (route) modules.push(route);
    const violations: string[] = [];
    for (const { file, source, imports } of modules) {
        if (
            /\b(?:current_time|web_search|fetch_url|searchWeb|fetchPage|TAVILY_API_KEY)\b/
                .test(withoutComments(source))
        ) {
            violations.push(`${file} -> concrete tool behavior`);
        }
        if (
            /\bfetch\s*\(|\bDeno\s*\.\s*resolveDns\s*\(/.test(
                withoutComments(source),
            )
        ) {
            violations.push(`${file} -> outbound tool I/O`);
        }
        for (const { specifier, resolved } of imports) {
            if (isUnder(resolved, "plugins")) {
                violations.push(`${file} -> ${specifier}`);
            }
        }
    }
    assertEquals(
        violations,
        [],
        "tool capabilities must be injected by composition",
    );
});
