import { validateUiMetadata } from "./manifest-metadata.ts";
/** Manifest normalization independent of package bytes or runtime policy. */

import type {
    PluginKind,
    PluginManifest,
    PluginPermissions,
    PluginRoute,
} from "../contracts/mod.ts";
import {
    fail,
    record,
    rejectUnknown,
    stringValue,
} from "./verification-errors.ts";

const MANIFEST_KEYS = new Set([
    "id",
    "version",
    "apiVersion",
    "name",
    "description",
    "dependencies",
    "kind",
    "trust",
    "capabilities",
    "routes",
    "permissions",
    "ui",
    "configSchema",
    "presetPage",
]);
const ROUTE_KEYS = new Set(["method", "path", "operation", "variant"]);
const PERMISSION_KEYS = new Set(["network", "filesystem", "subprocess"]);
const KINDS: readonly PluginKind[] = [
    "protocol",
    "api",
    "source",
    "middleware",
    "preset",
    "tool",
    "ui",
];

function alphaNumeric(code: number): boolean {
    return code >= 0x30 && code <= 0x39 || code >= 0x41 && code <= 0x5a ||
        code >= 0x61 && code <= 0x7a;
}

function identifier(
    value: string,
    label: string,
    max: number,
    allowed: (code: number) => boolean,
): void {
    if (value.length === 0 || value.length > max) {
        fail("invalid_manifest", `${label} must contain 1-${max} characters`);
    }
    for (const character of value) {
        if (!allowed(character.charCodeAt(0))) {
            fail("invalid_manifest", `${label} contains an invalid character`);
        }
    }
}

function validateId(value: string): void {
    identifier(
        value,
        "manifest.id",
        128,
        (code) =>
            alphaNumeric(code) || code === 0x2e || code === 0x5f ||
            code === 0x2d,
    );
    if (
        !alphaNumeric(value.charCodeAt(0)) ||
        !alphaNumeric(value.charCodeAt(value.length - 1)) ||
        value !== value.toLowerCase()
    ) {
        fail("invalid_manifest", `invalid plugin id: ${value}`);
    }
}

function numeric(value: string): boolean {
    return value.length > 0 &&
        [...value].every((char) => char >= "0" && char <= "9");
}

function tokenList(value: string, allowLeadingZero: boolean): boolean {
    if (value.length === 0) return false;
    return value.split(".").every((token) => {
        if (token.length === 0) return false;
        if (
            !allowLeadingZero && numeric(token) && token.length > 1 &&
            token.startsWith("0")
        ) return false;
        return [...token].every((char) =>
            alphaNumeric(char.charCodeAt(0)) || char === "-"
        );
    });
}

function validateVersion(value: string): void {
    if (value.length === 0 || value.length > 128) {
        fail("invalid_manifest", `invalid plugin version: ${value}`);
    }
    const [coreValue, build] = value.split("+", 2);
    const coreAndPre = coreValue ?? "";
    if (build !== undefined && !tokenList(build, true)) {
        fail("invalid_manifest", `invalid plugin version: ${value}`);
    }
    const [coreValueOnly, pre] = coreAndPre.split("-", 2);
    const core = coreValueOnly ?? "";
    const pieces = core.split(".");
    if (
        pieces.length !== 3 || pieces.some((piece) => !numeric(piece)) ||
        pieces.some((piece) => piece.length > 1 && piece.startsWith("0"))
    ) {
        fail("invalid_manifest", `invalid plugin version: ${value}`);
    }
    if (pre !== undefined && !tokenList(pre, false)) {
        fail("invalid_manifest", `invalid plugin version: ${value}`);
    }
}

function validateCapabilities(value: unknown): readonly string[] {
    if (value === undefined) return Object.freeze([]);
    if (!Array.isArray(value) || value.length > 256) {
        fail(
            "invalid_manifest",
            "manifest.capabilities must contain at most 256 strings",
        );
    }
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of value) {
        const capability = stringValue(
            item,
            "manifest.capabilities entry",
            "invalid_manifest",
        );
        identifier(
            capability,
            "manifest.capabilities entry",
            128,
            (code) =>
                alphaNumeric(code) || code === 0x2e || code === 0x3a ||
                code === 0x5f || code === 0x2d,
        );
        if (seen.has(capability)) {
            fail(
                "invalid_manifest",
                `duplicate capability: ${capability}`,
            );
        }
        seen.add(capability);
        result.push(capability);
    }
    return Object.freeze(result);
}

function validateDescription(value: unknown): string | undefined {
    if (value === undefined) return undefined;
    const description = stringValue(
        value,
        "manifest.description",
        "invalid_manifest",
    );
    if (
        !description.length || description.length > 2048 ||
        description !== description.trim()
    ) {
        fail(
            "invalid_manifest",
            "manifest.description must contain 1-2048 trimmed characters",
        );
    }
    return description;
}

function validateDependencies(
    value: unknown,
    id: string,
): readonly string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > 64) {
        fail(
            "invalid_manifest",
            "manifest.dependencies must contain at most 64 plugin IDs",
        );
    }
    if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        Reflect.ownKeys(value).length !== value.length + 1
    ) {
        fail(
            "invalid_manifest",
            "manifest.dependencies must be a plain dense JSON array",
        );
    }
    const seen = new Set<string>();
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(
            value,
            String(index),
        );
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
            fail(
                "invalid_manifest",
                "manifest.dependencies must use enumerable JSON data properties",
            );
        }
        const dependency = stringValue(
            descriptor.value,
            "manifest.dependencies entry",
            "invalid_manifest",
        );
        validateId(dependency);
        if (dependency === id || seen.has(dependency)) {
            fail(
                "invalid_manifest",
                `duplicate or self-referencing dependency: ${dependency}`,
            );
        }
        seen.add(dependency);
    }
    return Object.freeze([...seen]);
}

function validateRoutePath(value: string): void {
    if (
        value.length === 0 || value.length > 2048 || value[0] !== "/" ||
        value.startsWith("//")
    ) {
        fail("invalid_manifest", `unsafe route path: ${value}`);
    }
    if (
        value.includes("\\") || value.includes("?") || value.includes("#") ||
        value.includes("%") || value.includes("*") || value.includes(":")
    ) {
        fail("invalid_manifest", `unsafe route path: ${value}`);
    }
    for (const character of value) {
        if (
            character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f
        ) {
            fail("invalid_manifest", `unsafe route path: ${value}`);
        }
    }
    if (
        value.split("/").some((segment) => segment === "." || segment === "..")
    ) {
        fail("invalid_manifest", `unsafe route path: ${value}`);
    }
}

function validateRoutes(value: unknown): readonly PluginRoute[] {
    if (value === undefined) return Object.freeze([]);
    if (!Array.isArray(value) || value.length > 256) {
        fail(
            "invalid_manifest",
            "manifest.routes must contain at most 256 routes",
        );
    }
    const seen = new Set<string>();
    const result: PluginRoute[] = [];
    for (const item of value) {
        const route = record(item, "manifest route", "invalid_manifest");
        rejectUnknown(route, ROUTE_KEYS, "manifest route", "invalid_manifest");
        const method = stringValue(
            route.method,
            "route.method",
            "invalid_manifest",
        );
        if (
            method.length === 0 || method.length > 16 ||
            method !== method.toUpperCase() ||
            ![...method].every((character) =>
                character >= "A" && character <= "Z"
            )
        ) {
            fail("invalid_manifest", `invalid route method: ${method}`);
        }
        const path = stringValue(route.path, "route.path", "invalid_manifest");
        validateRoutePath(path);
        const operation = stringValue(
            route.operation,
            "route.operation",
            "invalid_manifest",
        );
        identifier(
            operation,
            "route.operation",
            128,
            (code) =>
                alphaNumeric(code) || code === 0x2e || code === 0x3a ||
                code === 0x5f || code === 0x2d,
        );
        const variant = route.variant === undefined ? undefined : stringValue(
            route.variant,
            "route.variant",
            "invalid_manifest",
        );
        if (variant !== undefined) {
            identifier(
                variant,
                "route.variant",
                64,
                (code) =>
                    alphaNumeric(code) || code === 0x2e || code === 0x3a ||
                    code === 0x5f || code === 0x2d,
            );
        }
        const key = `${method}\0${path}`;
        if (seen.has(key)) {
            fail(
                "invalid_manifest",
                `duplicate route: ${method} ${path}`,
            );
        }
        seen.add(key);
        result.push(Object.freeze({
            method,
            path,
            operation,
            ...(variant === undefined ? {} : { variant }),
        }));
    }
    return Object.freeze(result);
}

function validatePermissions(value: unknown): PluginPermissions {
    if (value === undefined) {
        return Object.freeze({
            network: false,
            filesystem: "none",
            subprocess: false,
        });
    }
    const input = record(value, "manifest.permissions", "invalid_permissions");
    rejectUnknown(
        input,
        PERMISSION_KEYS,
        "manifest.permissions",
        "invalid_permissions",
    );
    const network = input.network ?? false;
    const filesystem = input.filesystem ?? "none";
    const subprocess = input.subprocess ?? false;
    if (typeof network !== "boolean") {
        fail("invalid_permissions", "permissions.network must be boolean");
    }
    if (
        filesystem !== "none" && filesystem !== "read" &&
        filesystem !== "read-write"
    ) {
        fail(
            "invalid_permissions",
            "permissions.filesystem must be none, read, or read-write",
        );
    }
    if (typeof subprocess !== "boolean") {
        fail("invalid_permissions", "permissions.subprocess must be boolean");
    }
    return Object.freeze({ network, filesystem, subprocess });
}

/** Validate untrusted JSON and apply fail-closed defaults. */
export function validatePluginManifest(value: unknown): PluginManifest {
    const input = record(value, "manifest", "invalid_manifest");
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
        fail("invalid_manifest", "manifest must be a plain JSON object");
    }
    for (const key of Reflect.ownKeys(input)) {
        const descriptor = Object.getOwnPropertyDescriptor(input, key);
        if (
            typeof key !== "string" || !descriptor ||
            !("value" in descriptor) || !descriptor.enumerable
        ) {
            fail(
                "invalid_manifest",
                "manifest must use enumerable JSON data properties",
            );
        }
    }
    rejectUnknown(input, MANIFEST_KEYS, "manifest", "invalid_manifest");
    const id = stringValue(input.id, "manifest.id", "invalid_manifest");
    validateId(id);
    const version = stringValue(
        input.version,
        "manifest.version",
        "invalid_manifest",
    );
    validateVersion(version);
    if (input.apiVersion !== "1") {
        fail("invalid_manifest", "unsupported plugin API");
    }
    const name = stringValue(input.name, "manifest.name", "invalid_manifest");
    if (name.length === 0 || name.length > 128 || name !== name.trim()) {
        fail("invalid_manifest", "manifest.name must be trimmed and non-empty");
    }
    const kind = stringValue(input.kind, "manifest.kind", "invalid_manifest");
    if (!KINDS.includes(kind as PluginKind)) {
        fail("invalid_manifest", `invalid plugin kind: ${kind}`);
    }
    const trust = input.trust ?? "isolated";
    if (trust !== "trusted" && trust !== "isolated") {
        fail("invalid_manifest", `invalid plugin trust: ${String(trust)}`);
    }
    const description = validateDescription(input.description);
    const dependencies = validateDependencies(input.dependencies, id);
    return Object.freeze({
        id,
        version,
        apiVersion: "1",
        name,
        ...(description === undefined ? {} : { description }),
        ...(dependencies === undefined ? {} : { dependencies }),
        kind: kind as PluginKind,
        trust,
        capabilities: validateCapabilities(input.capabilities),
        routes: validateRoutes(input.routes),
        permissions: validatePermissions(input.permissions),
        ...validateUiMetadata(input),
    });
}
