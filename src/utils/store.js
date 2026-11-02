import { Store } from 'tauri-plugin-store-api';
import { appConfigDir, join } from '@tauri-apps/api/path';
import { watch } from 'tauri-plugin-fs-watch-api';
import { invoke } from '@tauri-apps/api';

export let store = new Store();

// In-memory copy of the whole store, read once at startup so hooks can get config synchronously.
// Kept current by store://change (emitted to every window on set/delete) and by reloads of the file.
let snapshot = new Map();

async function loadSnapshot() {
    snapshot = new Map(await store.entries());
}

export function getSnapshot(key) {
    return snapshot.get(key) ?? null;
}

export function setSnapshot(key, value) {
    snapshot.set(key, value);
}

export async function initStore() {
    const appConfigDirPath = await appConfigDir();
    const appConfigPath = await join(appConfigDirPath, 'config.json');
    store = new Store(appConfigPath);
    await loadSnapshot();
    await store.onChange((key, value) => {
        setSnapshot(key, value);
    });
    const _ = await watch(appConfigPath, async () => {
        await store.load();
        await loadSnapshot();
        await invoke('reload_store');
    });
}
