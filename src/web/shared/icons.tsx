// @deno-types="npm:lucide@1.47.0/dist/lucide.d.ts"
import {
    Activity,
    ArrowDown,
    ArrowLeft,
    ArrowRight,
    ArrowUp,
    Brain,
    Bug,
    Cable,
    Check,
    ChevronDown,
    ChevronRight,
    CircleX,
    Copy,
    Cpu,
    Download,
    ExternalLink,
    Eye,
    EyeOff,
    Gauge,
    type IconNode,
    Image,
    Info,
    KeyRound,
    LayoutDashboard,
    LayoutGrid,
    List,
    LoaderCircle,
    LogOut,
    Menu,
    MessageSquare,
    Moon,
    PanelLeftClose,
    PanelLeftOpen,
    Paperclip,
    Pencil,
    Plus,
    Power,
    Puzzle,
    RefreshCw,
    ScrollText,
    Search,
    SlidersHorizontal,
    Square,
    Sun,
    Trash2,
    TriangleAlert,
    UserRoundCog,
    X,
    Zap,
} from "lucide";

const icons = {
    activity: Activity,
    plus: Plus,
    back: ArrowLeft,
    "arrow-left": ArrowLeft,
    "arrow-right": ArrowRight,
    "chevron-right": ChevronRight,
    "chevron-down": ChevronDown,
    "external-link": ExternalLink,
    account: UserRoundCog,
    send: ArrowUp,
    stop: Square,
    window: Square,
    attach: Paperclip,
    copy: Copy,
    check: Check,
    eye: Eye,
    "eye-off": EyeOff,
    refresh: RefreshCw,
    moon: Moon,
    sun: Sun,
    menu: Menu,
    close: X,
    image: Image,
    spinner: LoaderCircle,
    edit: Pencil,
    trash: Trash2,
    "log-out": LogOut,
    key: KeyRound,
    overview: LayoutDashboard,
    channels: Cable,
    chat: MessageSquare,
    settings: SlidersHorizontal,
    plugin: Puzzle,
    logs: ScrollText,
    search: Search,
    power: Power,
    "arrow-down": ArrowDown,
    "arrow-up": ArrowUp,
    "panel-close": PanelLeftClose,
    "panel-open": PanelLeftOpen,
    "layout-grid": LayoutGrid,
    list: List,
    download: Download,
    cpu: Cpu,
    zap: Zap,
    gauge: Gauge,
    brain: Brain,
    info: Info,
    warning: TriangleAlert,
    error: CircleX,
    bug: Bug,
} satisfies Record<string, IconNode>;

export type IconName = keyof typeof icons;

interface IconOptions {
    readonly class?: string;
    readonly size?: number;
}

const svgNamespace = "http://www.w3.org/2000/svg";

/** Lucide supplies every shape; callers only select an application action. */
export function iconNode(name: IconName): IconNode {
    return icons[name];
}

function iconAttributes(name: IconName, options: IconOptions) {
    return {
        xmlns: svgNamespace,
        class: options.class ? `icon ${options.class}` : "icon",
        width: options.size ?? 18,
        height: options.size ?? 18,
        viewBox: "0 0 24 24",
        fill: name === "stop" ? "currentColor" : "none",
        stroke: "currentColor",
        "stroke-width": "1.7",
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        "aria-hidden": "true",
        focusable: "false",
    };
}

/** The build's JSX configuration selects Hono SSR or DOM for this same component. */
export function Icon({ name, ...options }: IconOptions & { name: IconName }) {
    return (
        <svg {...iconAttributes(name, options)}>
            {iconNode(name).map(([Tag, attributes], index) => (
                <Tag key={index} {...attributes} />
            ))}
        </svg>
    );
}

/** Non-JSX navigation receives its document explicitly, without global DOM access. */
export function createIconElement(
    name: IconName,
    dom: Pick<Document, "createElementNS">,
    options: IconOptions = {},
): SVGSVGElement {
    const svg = dom.createElementNS(svgNamespace, "svg");
    for (
        const [attribute, value] of Object.entries(
            iconAttributes(name, options),
        )
    ) {
        svg.setAttribute(attribute, String(value));
    }
    for (const [tag, attributes] of iconNode(name)) {
        const child = dom.createElementNS(svgNamespace, tag);
        for (const [attribute, value] of Object.entries(attributes)) {
            if (value !== undefined) {
                child.setAttribute(attribute, String(value));
            }
        }
        svg.appendChild(child);
    }
    return svg;
}
