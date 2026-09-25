/** Read a value from a host form control; Hono's DOM events use native Event. */
export function controlValue(event: Event): string {
    return (event.currentTarget as
        | HTMLInputElement
        | HTMLSelectElement
        | HTMLTextAreaElement).value;
}
