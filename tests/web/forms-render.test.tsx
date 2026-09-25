import {
    assert,
    assertFalse,
    assertMatch,
    assertStringIncludes,
} from "@std/assert";
import type { SourceConfigSchema } from "@heimdall/admin-contracts/forms.ts";
import { SchemaFields } from "@heimdall/core/web/components/schema-fields.tsx";

const schema: SourceConfigSchema = {
    version: 1,
    id: "source",
    fields: [{
        type: "group",
        id: "connection",
        label: "连接参数",
        help: "由主机生成配置表单。",
        fields: [
            {
                type: "string",
                name: "endpoint",
                label: "接口地址",
                format: "url",
                required: true,
                help: "填写完整地址。",
            },
            { type: "secret", name: "token", label: "密钥", required: true },
            {
                type: "bool",
                name: "enabled",
                label: "启用",
                required: true,
                default: false,
            },
            {
                type: "enum",
                name: "region",
                label: "区域",
                options: [{ value: "cn", label: "中国" }, {
                    value: "us",
                    label: "美国",
                }],
            },
            {
                type: "authorization",
                name: "login",
                label: "账户授权",
                action: { id: "authorize", params: { provider: "demo" } },
            },
        ],
    }],
};

Deno.test("schema SSR never echoes a saved secret and preserves existing required secrets", () => {
    const html = (<SchemaFields
        schema={schema}
        values={{ token: "DO-NOT-LEAK" }}
        existingSecrets={["token"]}
    />).toString();
    assertFalse(html.includes("DO-NOT-LEAK"));
    assertStringIncludes(html, "已配置，留空保留原值。");
    const secret = html.match(/<input[^>]*name="token"[^>]*>/)?.[0] ?? "";
    assertStringIncludes(secret, 'type="password"');
    assertStringIncludes(secret, 'value=""');
    assertMatch(secret, /autocomplete="new-password"/i);
    assertFalse(/\srequired(?:[\s=>])/.test(secret));
    const fresh = (<SchemaFields schema={schema} />).toString().match(
        /<input[^>]*name="token"[^>]*>/,
    )?.[0] ?? "";
    assertMatch(fresh, /\srequired(?:[\s=>])/);
});

Deno.test("schema SSR connects labels, group guidance and field errors without leaking executable content", () => {
    const html = (<SchemaFields
        schema={schema}
        idPrefix="settings"
        values={{ endpoint: '<script>alert("x")</script>' }}
        errors={{ endpoint: "地址不正确" }}
    />).toString();
    assertStringIncludes(html, "<legend>连接参数</legend>");
    assertStringIncludes(
        html,
        'aria-describedby="settings-group-connection-help"',
    );
    assertStringIncludes(html, '<label for="settings-endpoint">');
    assertStringIncludes(html, 'id="settings-endpoint"');
    assertStringIncludes(
        html,
        'aria-describedby="settings-endpoint-help settings-endpoint-error"',
    );
    assertStringIncludes(html, 'aria-invalid="true"');
    assertStringIncludes(
        html,
        'id="settings-endpoint-error" role="alert">地址不正确',
    );
    assertFalse(html.includes("<script>"));
    assertStringIncludes(html, "&lt;script&gt;");
    assertFalse(html.includes("<form"));
});

Deno.test("schema SSR accepts an explicit false boolean, selects saved enums and disables authorization", () => {
    const html = (<SchemaFields
        schema={schema}
        values={{ enabled: false, region: "us" }}
        authorization={{
            login: { state: "pending", message: "正在等待用户授权" },
        }}
    />).toString();
    const checkbox = html.match(/<input[^>]*name="enabled"[^>]*>/)?.[0] ?? "";
    assertStringIncludes(checkbox, 'type="checkbox"');
    assertFalse(/\srequired(?:[\s=>])/.test(checkbox));
    assertFalse(/\schecked(?:[\s=>])/.test(checkbox));
    assertMatch(html, /<option value="us" selected(?:="")?>美国<\/option>/);
    const button = html.match(/<button[^>]*name="login"[^>]*>/)?.[0] ?? "";
    assertMatch(button, /\sdisabled(?:[\s=>])/);
    assertStringIncludes(button, 'aria-busy="true"');
    assertStringIncludes(
        html,
        'role="status" aria-live="polite">正在等待用户授权',
    );
    assertFalse(html.includes('"provider"'));
    assert(html.includes("正在授权…"));
});
