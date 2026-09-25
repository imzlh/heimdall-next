import { useEffect, useRef, useState } from "hono/jsx/dom";
import { createChatController } from "./controller.ts";
import type { ChatController, ChatInitial } from "./types.ts";

export function useChat(initial: ChatInitial, onSelect?: (id: string) => void) {
    const reference = useRef<ChatController | null>(null);
    if (!reference.current) {
        reference.current = createChatController({ initial, onSelect });
    }
    const controller = reference.current;
    const [state, setState] = useState(controller.getState());
    useEffect(() => {
        const unsubscribe = controller.subscribe(setState);
        setState(controller.getState());
        return () => {
            unsubscribe();
            controller.dispose();
        };
    }, [controller]);
    return { state, controller };
}
