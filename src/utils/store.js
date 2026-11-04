import { Store } from 'tauri-plugin-store-api';
import { appConfigDir, join } from '@tauri-apps/api/path';
import { watch } from 'tauri-plugin-fs-watch-api';
import { invoke } from '@tauri-apps/api';
import { DEFAULT_RECOGNIZE_SERVICE_LIST } from './service_instance';

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

// One-time migration to local PaddleOCR: a recognize list left at the old default ['system'] gets
// the new default. The marker keeps a user who later removes paddle again from being migrated twice.
const PADDLE_MIGRATION_KEY = 'recognize_paddle_migrated';

async function migrateRecognizeServiceList() {
    if (snapshot.get(PADDLE_MIGRATION_KEY)) {
        return;
    }
    const list = snapshot.get('recognize_service_list');
    try {
        if (Array.isArray(list) && list.length === 1 && list[0] === 'system') {
            await store.set('recognize_service_list', DEFAULT_RECOGNIZE_SERVICE_LIST);
            snapshot.set('recognize_service_list', DEFAULT_RECOGNIZE_SERVICE_LIST);
        }
        await store.set(PADDLE_MIGRATION_KEY, true);
        snapshot.set(PADDLE_MIGRATION_KEY, true);
        await store.save();
        // the backend reads the list to decide whether to preload the models
        await invoke('reload_store');
    } catch (e) {
        // a failed migration must not keep the window from starting; it is retried next launch
        console.error(`Recognize service list migration failed: ${e}`);
    }
}

export async function initStore() {
    const appConfigDirPath = await appConfigDir();
    const appConfigPath = await join(appConfigDirPath, 'config.json');
    store = new Store(appConfigPath);
    await loadSnapshot();
    await migrateRecognizeServiceList();
    await store.onChange((key, value) => {
        setSnapshot(key, value);
    });
    const _ = await watch(appConfigPath, async () => {
        await store.load();
        await loadSnapshot();
        await invoke('reload_store');
    });
}
