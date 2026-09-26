/** Public plugin boundary. Implementations stay in server/plugin packages. */

import type { JsonValue, OperationRequest, StreamFrame } from "../hip/mod.ts";
import type { ResolvedSourceProxy, SourceProxySelection } from "./proxy.ts";

export type JsonObject = Readonly<Record<string, JsonValue>>;

export type PluginKind =
    | "protocol"
    | "api"
    | "source"
    | "middleware"
    | "preset"
    | "tool"
    | "ui";

export type PluginTrust = "trusted" | "isolated";

export interface PluginManifest {
    readonly id: string;
    readonly version: string;
    readonly apiVersion: "1";
    readonly name: string;
    /** Human-readable operator description; rendered as plain text. */
    readonly description?: string;
    /** Declared related plugin IDs. Does not grant automatic installation. */
    readonly dependencies?: readonly string[];
    readonly kind: PluginKind;
    readonly trust: PluginTrust;
    readonly capabilities?: readonly string[];
    readonly routes?: readonly PluginRoute[];
    readonly permissions?: PluginPermissions;
    /** Declarative operator UI metadata. Only the host chooses render trust. */
    readonly ui?: readonly JsonObject[];
    /** Source configuration schema; interpreted by the host's form renderer. */
    readonly configSchema?: JsonObject;
    /** Preset-owned browser page. Execution still requires an explicit host grant. */
    readonly presetPage?: { readonly modulePath: string };
}

export interface PluginRoute {
    readonly method: string;
    readonly path: string;
    readonly operation: string;
    /** Optional protocol-specific codec variant, independent of URL routing. */
    readonly variant?: string;
}

export interface PluginPermissions {
    readonly network?: boolean;
    readonly filesystem?: "none" | "read" | "read-write";
    readonly subprocess?: boolean;
}

export interface RequestContext {
    readonly requestId: string;
    readonly request: Request;
    readonly signal: AbortSignal;
    readonly route: PluginRoute;
    readonly metadata: Readonly<Record<string, JsonValue>>;
}

export interface ProtocolPlugin {
    readonly manifest: PluginManifest;
    parse(context: RequestContext): Promise<OperationRequest>;
    serialize(
        context: RequestContext,
        input: OperationRequest,
        events: AsyncIterable<StreamFrame>,
    ): Promise<Response>;
    /** Encode host or upstream failures in the client's wire dialect. */
    serializeError?(context: RequestContext, error: unknown): Response;
}

/** Protocol-layer failure that the HTTP host maps to a wire error. */
export class ProtocolError extends Error {
    constructor(
        public readonly status: number,
        message: string,
        public readonly code = "invalid_request",
    ) {
        super(message);
        this.name = "ProtocolError";
    }
}

export interface SourceCapability {
    readonly operation: string;
    readonly models?: readonly string[];
    readonly streaming: boolean;
    readonly features?: readonly string[];
    readonly priority?: number;
}

export interface SourceContext {
    readonly requestId: string;
    readonly signal: AbortSignal;
    readonly metadata: Readonly<Record<string, JsonValue>>;
}

export interface InferenceSource {
    readonly id: string;
    readonly capabilities: readonly SourceCapability[];
    execute(
        input: OperationRequest,
        context: SourceContext,
    ): AsyncIterable<StreamFrame>;
    /** Optional reachability check. The plugin owns any network I/O. */
    probe?(signal: AbortSignal): Promise<SourceProbeResult>;
}

/** Result of a source reachability check. Model ids are optional catalog data. */
export interface SourceProbeResult {
    readonly ok: boolean;
    readonly message: string;
    readonly models?: readonly string[];
}

/** Host persistence is scoped to the source instance; plugins never receive a store. */
export interface SourceFactoryOptions<Config = unknown> {
    /** Read at the start of network work. Adoption belongs to the plugin. */
    readonly getProxy?: () => ResolvedSourceProxy;
    readonly onConfigUpdate?: (
        updated: Config,
        previous: Config,
    ) => Promise<void>;
}

/** Provider-owned validation, transport and write-only configuration handling. */
export interface SourcePluginFactory<Config = unknown> {
    readonly manifest: PluginManifest;
    validate(input: unknown): Config;
    create(
        config: Config,
        options?: SourceFactoryOptions<Config>,
    ): InferenceSource;
    redact?(config: Config): unknown;
    mergeConfig?(input: unknown, previous: Config | undefined): unknown;
}

export type HookResult<T> = T | undefined | PromiseLike<T | undefined>;

export interface RequestHookContext {
    readonly request: RequestContext;
    readonly pluginId: string;
}

export interface MiddlewarePlugin {
    readonly manifest: PluginManifest;
    readonly order?: number;
    transformRequest?: (
        input: OperationRequest,
        context: RequestHookContext,
    ) => HookResult<OperationRequest>;
    transformFrames?: (
        input: OperationRequest,
        context: RequestHookContext,
        frames: AsyncIterable<StreamFrame>,
    ) => HookResult<AsyncIterable<StreamFrame>>;
}

export interface ApiRequestContext {
    readonly requestId: string;
    readonly request: Request;
    readonly signal: AbortSignal;
    readonly route: PluginRoute;
    /** Optional host preference lookup, for plugin-owned setup/authorization I/O. */
    readonly resolveProxy?: (
        selection?: SourceProxySelection,
    ) => ResolvedSourceProxy;
}

export interface ApiPlugin {
    readonly manifest: PluginManifest;
    handle(context: ApiRequestContext): Response | Promise<Response>;
}

export interface PresetApplication {
    readonly sourcePluginId: string;
    readonly config: JsonValue;
}

export interface PresetPlugin {
    readonly manifest: PluginManifest;
    readonly sourcePluginId: string;
    apply(input: unknown): PresetApplication;
    redact?(application: PresetApplication): JsonValue;
}

/** Wire shape for errors crossing a plugin boundary. Runtime error classes are server-owned. */
export interface PluginError {
    readonly code: string;
    readonly message: string;
    readonly status?: number;
    readonly details?: JsonValue;
}
