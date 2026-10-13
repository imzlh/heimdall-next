import type { Child } from "hono/jsx";
import { Icon, type IconName } from "./icons.tsx";

export function SettingsCard(
    { id, title, description, icon, children }: {
        id: string;
        title: string;
        description?: string;
        icon: IconName;
        children?: Child;
    },
) {
    return (
        <section class="settings-card" aria-labelledby={id}>
            <div class="settings-card-heading">
                <span class="settings-card-icon">
                    <Icon name={icon} />
                </span>
                <div>
                    <h3 id={id}>{title}</h3>
                    {description && <p>{description}</p>}
                </div>
            </div>
            {children}
        </section>
    );
}
