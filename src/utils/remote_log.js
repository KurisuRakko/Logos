import { invoke } from '@tauri-apps/api';

import { appVersion, osType } from './env';
import { logosApiBase } from './logos_account';

// Client diagnostics for logos-api POST /v1/logs. Per-window in-memory queue, flushed in
// batches after 5 s of quiet; dropped when signed out. Never put source text, translations,
// tokens or clipboard content in message/context.
const MAX_QUEUE = 50;
const BATCH_SIZE = 20;
const FLUSH_DELAY_MS = 5000;
const MAX_MESSAGE = 2000;
const MAX_CONTEXT_BYTES = 4096;

let queue = [];
let timer = null;

function safeContext(context) {
    if (!context || typeof context !== 'object') return undefined;
    try {
        const json = JSON.stringify(context);
        if (new TextEncoder().encode(json).length <= MAX_CONTEXT_BYTES) return context;
        const { stack: _stack, ...rest } = context;
        const trimmed = JSON.stringify(rest);
        return new TextEncoder().encode(trimmed).length <= MAX_CONTEXT_BYTES ? rest : undefined;
    } catch {
        return undefined;
    }
}

export function remoteLog(level, event, message, context) {
    try {
        queue.push({
            level: ['error', 'warn', 'info'].includes(level) ? level : 'info',
            event: String(event).slice(0, 64),
            message: String(message ?? '').slice(0, MAX_MESSAGE),
            context: safeContext(context),
            client_time: new Date().toISOString(),
        });
        if (queue.length > MAX_QUEUE) {
            queue = queue.slice(queue.length - MAX_QUEUE);
        }
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, FLUSH_DELAY_MS);
    } catch {
        // logging must never break the caller
    }
}

async function flush() {
    timer = null;
    const entries = queue;
    queue = [];
    if (entries.length === 0) return;
    let token = null;
    try {
        token = await invoke('logos_account_token');
    } catch {
        return;
    }
    if (!token) return;
    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        try {
            await window.fetch(`${logosApiBase()}/v1/logs`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
                body: JSON.stringify({
                    app_version: appVersion,
                    os: osType,
                    entries: entries.slice(i, i + BATCH_SIZE),
                }),
            });
        } catch {
            // no retry, no self-logging
        }
    }
}

// Global error hooks; call once per window
export function installRemoteErrorLog() {
    window.addEventListener('error', (e) => {
        remoteLog('error', 'js_error', String(e.message ?? e.error ?? 'error').slice(0, 500), {
            source: 'window.error',
            file: typeof e.filename === 'string' ? e.filename.replace(/^.*\//, '') : undefined,
            line: e.lineno,
            col: e.colno,
            stack: typeof e.error?.stack === 'string' ? e.error.stack.slice(0, 1500) : undefined,
        });
    });
    window.addEventListener('unhandledrejection', (e) => {
        const reason = e.reason;
        remoteLog('error', 'js_error', String(reason?.message ?? reason ?? 'rejection').slice(0, 500), {
            source: 'unhandledrejection',
            code: typeof reason?.code === 'string' ? reason.code : undefined,
            stack: typeof reason?.stack === 'string' ? reason.stack.slice(0, 1500) : undefined,
        });
    });
}
