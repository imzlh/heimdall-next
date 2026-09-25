import { assert, assertEquals } from "@std/assert";
import { extractTitle, htmlToText } from "../../plugins/tool-web/html-text.ts";

Deno.test("htmlToText strips script/style/head noise and their content", () => {
    const html = `<!DOCTYPE html><html><head><title>T</title>
        <style>.a{color:red}</style></head>
        <body>
            <script>var secret = "do not leak";</script>
            <p>Hello <b>world</b></p>
            <noscript>enable js</noscript>
        </body></html>`;
    const text = htmlToText(html, 1000);
    assertEquals(text, "Hello world");
    assert(!text.includes("secret"));
    assert(!text.includes("color:red"));
    assert(!text.includes("enable js"));
});

Deno.test("htmlToText decodes common entities", () => {
    const html =
        "<p>Tom &amp; Jerry &lt;tag&gt; &quot;q&quot; it&#39;s 90&#176; a&nbsp;b &#x41;</p>";
    assertEquals(
        htmlToText(html, 1000),
        `Tom & Jerry <tag> "q" it's 90° a b A`,
    );
});

Deno.test("htmlToText leaves unknown entities untouched", () => {
    assertEquals(
        htmlToText("<p>&notreal; &#nope;</p>", 1000),
        "&notreal; &#nope;",
    );
});

Deno.test("htmlToText collapses whitespace across tags and lines", () => {
    const html =
        "<div>one</div>\n\n   <div>two    three</div>\t<div>four</div>";
    assertEquals(htmlToText(html, 1000), "one two three four");
});

Deno.test("htmlToText respects maxChars", () => {
    const text = htmlToText("<p>abcdefghij</p>", 4);
    assert(text.length <= 4);
    assertEquals(text, "abcd");
    assertEquals(htmlToText("<p>hello</p>", 0), "");
});

Deno.test("extractTitle returns the first trimmed, decoded title", () => {
    assertEquals(
        extractTitle("<html><head><title>  Hello &amp; Bye  </title></head>"),
        "Hello & Bye",
    );
    assertEquals(
        extractTitle("<title>First</title><title>Second</title>"),
        "First",
    );
    assertEquals(
        extractTitle('<title lang="en">Attr Title</title>'),
        "Attr Title",
    );
});

Deno.test("extractTitle returns undefined when absent or empty", () => {
    assertEquals(extractTitle("<html><body>no title</body></html>"), undefined);
    assertEquals(extractTitle("<title>   </title>"), undefined);
});
