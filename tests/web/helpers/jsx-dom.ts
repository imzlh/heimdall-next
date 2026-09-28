import { flushSync } from "hono/jsx/dom";

/**
 * A deliberately small DOM surface for exercising the real Hono DOM renderer.
 * It implements tree mutation, native EventTarget dispatch, form submission,
 * focus and dialog state. It does not emulate layout, paint, browser constraint
 * validation, event bubbling or the dialog top layer; browser acceptance remains
 * a separate check. No renderer internals or component hooks are replaced.
 */
class TestNode extends EventTarget {
    readonly childNodes: TestNode[] = [];
    parentNode: TestNode | null = null;

    constructor(
        readonly nodeName: string,
        readonly nodeType: number,
        protected readonly owner: TestDocument,
        private text = "",
    ) {
        super();
    }

    get textContent(): string {
        return this.nodeType === 3
            ? this.text
            : this.childNodes.map((child) => child.textContent).join("");
    }

    set textContent(value: string) {
        if (this.nodeType === 3) this.text = String(value);
        else {
            this.replaceChildren();
            if (value) this.appendChild(this.owner.createTextNode(value));
        }
    }

    get isConnected(): boolean {
        return Object.is(this, this.owner.body) ||
            Object.is(this, this.owner.head) ||
            this.parentNode?.isConnected === true;
    }

    getRootNode(): TestNode {
        return this.parentNode?.getRootNode() ?? this;
    }

    appendChild(node: TestNode): TestNode {
        return this.insertBefore(node, null);
    }

    append(...nodes: TestNode[]): void {
        for (const node of nodes) this.appendChild(node);
    }

    insertBefore(node: TestNode, before: TestNode | null): TestNode {
        if (node.nodeType === 11) {
            for (const child of [...node.childNodes]) {
                this.insertBefore(child, before);
            }
            return node;
        }
        if (node === before) return node;
        node.remove();
        const index = before ? this.childNodes.indexOf(before) : -1;
        if (before && index < 0) throw new Error("Reference is not a child");
        this.childNodes.splice(
            index < 0 ? this.childNodes.length : index,
            0,
            node,
        );
        node.parentNode = this;
        return node;
    }

    replaceChildren(...nodes: TestNode[]): void {
        for (const child of [...this.childNodes]) child.remove();
        for (const child of nodes) this.appendChild(child);
    }

    remove(): void {
        if (!this.parentNode) return;
        const siblings = this.parentNode.childNodes;
        siblings.splice(siblings.indexOf(this), 1);
        this.parentNode = null;
    }

    contains(node: TestNode): boolean {
        return this === node ||
            this.childNodes.some((child) => child.contains(node));
    }
}

export class TestElement extends TestNode {
    private readonly attributes = new Map<string, string>();
    readonly style = { cssText: "", setProperty: () => {} };
    value = "";
    checked = false;
    selected = false;
    selectedIndex = 0;
    multiple = false;
    showModalCalls = 0;
    closeCalls = 0;

    constructor(tag: string, owner: TestDocument) {
        super(tag.toUpperCase(), 1, owner);
    }

    get disabled(): boolean {
        return this.hasAttribute("disabled");
    }

    get open(): boolean {
        return this.hasAttribute("open");
    }

    setAttribute(name: string, value: string): void {
        this.attributes.set(name.toLowerCase(), String(value));
    }

    getAttribute(name: string): string | null {
        return this.attributes.get(name.toLowerCase()) ?? null;
    }

    hasAttribute(name: string): boolean {
        return this.attributes.has(name.toLowerCase());
    }

    removeAttribute(name: string): void {
        this.attributes.delete(name.toLowerCase());
    }

    focus(): void {
        this.owner.activeElement = this;
    }

    showModal(): void {
        this.showModalCalls++;
        this.setAttribute("open", "");
    }

    close(): void {
        this.closeCalls++;
        this.removeAttribute("open");
    }

    scrollTo(): void {}

    querySelector(selector: string): TestElement | null {
        return this.querySelectorAll(selector)[0] ?? null;
    }

    querySelectorAll(selector: string): TestElement[] {
        const elements: TestElement[] = [];
        const visit = (node: TestNode) => {
            for (const child of node.childNodes) {
                if (child instanceof TestElement && child.matches(selector)) {
                    elements.push(child);
                }
                visit(child);
            }
        };
        visit(this);
        return elements;
    }

    private matches(selector: string): boolean {
        const match = selector.match(
            /^([\w-]+)?((?:\[[\w-]+(?:="[^"]*")?\])*)$/,
        );
        if (!match || (!match[1] && !match[2])) {
            throw new Error(`Unsupported test selector: ${selector}`);
        }
        if (match[1] && this.nodeName !== match[1].toUpperCase()) return false;
        for (const attr of match[2]!.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
            const name = attr[1]!;
            const value = attr[2];
            if (value === undefined) {
                if (!this.hasAttribute(name)) return false;
            } else if (this.getAttribute(name) !== value) return false;
        }
        return true;
    }

    /** Only the button's default submit action is modeled. */
    click(): void {
        if (this.disabled) return;
        const permitted = this.dispatchEvent(
            new Event("click", { cancelable: true }),
        );
        if (
            permitted && this.nodeName === "BUTTON" &&
            this.getAttribute("type") !== "button"
        ) {
            let parent = this.parentNode;
            while (parent && parent.nodeName !== "FORM") {
                parent = parent.parentNode;
            }
            parent?.dispatchEvent(
                new CustomEvent("submit", { cancelable: true, detail: {} }),
            );
        }
    }
}

class TestSvgElement extends TestElement {}

class TestDocument {
    readonly body = new TestElement("body", this);
    readonly head = new TestElement("head", this);
    activeElement: TestElement | null = this.body;

    createElement(tag: string): TestElement {
        return new TestElement(tag, this);
    }

    createElementNS(_namespace: string, tag: string): TestElement {
        return new TestSvgElement(tag, this);
    }

    createTextNode(value: string): TestNode {
        return new TestNode("#text", 3, this, String(value));
    }

    createDocumentFragment(): TestNode {
        return new TestNode("#document-fragment", 11, this);
    }
}

export function installTestDom({ reducedMotion = true } = {}) {
    const document = new TestDocument();
    const frames = new Map<number, FrameRequestCallback>();
    const originals = new Map<string, PropertyDescriptor | undefined>();
    const navigation: string[] = [];
    const storageWrites: string[] = [];
    let frameId = 0;
    const install = (key: string, value: unknown) => {
        originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
        Object.defineProperty(globalThis, key, { configurable: true, value });
    };
    const location = {
        get href() {
            return "http://localhost/admin";
        },
        set href(value: string) {
            navigation.push(value);
        },
        assign: (value: string) => navigation.push(value),
        replace: (value: string) => navigation.push(value),
    };
    const storage = {
        getItem: () => null,
        setItem: (key: string, value: string) =>
            storageWrites.push(`${key}=${value}`),
        removeItem: () => {},
        clear: () => {},
    };
    install("document", document);
    install("HTMLElement", TestElement);
    install("SVGElement", TestSvgElement);
    install("matchMedia", () => ({ matches: reducedMotion }));
    install("requestAnimationFrame", (callback: FrameRequestCallback) => {
        frames.set(++frameId, callback);
        return frameId;
    });
    install("cancelAnimationFrame", (id: number) => frames.delete(id));
    install("location", location);
    install("open", (url: string) => navigation.push(url));
    install("history", {
        pushState: (_state: unknown, _title: string, url: string) =>
            navigation.push(url),
        replaceState: (_state: unknown, _title: string, url: string) =>
            navigation.push(url),
    });
    install("sessionStorage", storage);
    install("localStorage", storage);
    const root = document.createElement("div");
    document.body.appendChild(root);

    return {
        document,
        root,
        navigation,
        storageWrites,
        /** Drain the real renderer's microtasks and its scheduled effects. */
        async act(callback: () => void = () => {}) {
            flushSync(callback);
            for (let pass = 0; pass < 8; pass++) {
                await Promise.resolve();
                const ready = [...frames.values()];
                frames.clear();
                for (const frame of ready) {
                    flushSync(() => frame(performance.now()));
                }
            }
        },
        restore() {
            for (const [key, descriptor] of originals) {
                if (descriptor) {
                    Object.defineProperty(globalThis, key, descriptor);
                } else Reflect.deleteProperty(globalThis, key);
            }
        },
    };
}
