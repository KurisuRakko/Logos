import { appWindow } from '@tauri-apps/api/window';

// These windows are created once and then only hidden: the backend calls show() + set_focus()
// on the existing window and emits `window_reactivate` (the translate window also gets `new_text`).
export const RESIDENT_WINDOWS = ['translate', 'screenshot'];

// Dispatched on `window` right before a resident window hides itself, so components can drop
// per-activation state (text, results, images) and the next show never flashes stale content.
export const WINDOW_HIDE_EVENT = 'pot_window_hide';

export const isResidentWindow = () => RESIDENT_WINDOWS.includes(appWindow.label);

// Let the hide handlers' cleared content paint before the window hides, otherwise that last
// stale frame is what shows on the next activation; capped in case frames are not delivered
const nextFrame = () =>
    new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
        setTimeout(resolve, 50);
    });

// Replacement for appWindow.close(): resident windows hide, other windows still close.
export async function dismissWindow() {
    if (isResidentWindow()) {
        window.dispatchEvent(new Event(WINDOW_HIDE_EVENT));
        await nextFrame();
        await appWindow.hide();
    } else {
        await appWindow.close();
    }
}
