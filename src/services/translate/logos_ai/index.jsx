import i18n from 'i18next';

import { LogosApiError, logosApiFetch } from '../../../utils/logos_account';
import { remoteLog } from '../../../utils/remote_log';

// POST /v1/translate answers with text/event-stream:
//   data: {"delta":"…"}  (repeated)
//   data: {"done":true,"cost_micro":n,"remaining_ratio":0..1}
// Errors arrive as JSON before the stream opens and are raised by logosApiFetch.
export async function translate(text, from, to, options) {
    const started = Date.now();
    try {
        const result = await translateStream(text, from, to, options);
        remoteLog('info', 'translate_ok', '', { duration_ms: Date.now() - started, text_length: text.length });
        return result;
    } catch (e) {
        // only metadata; the text itself never leaves the client through logs
        if (e?.code !== 'not_logged_in') {
            const status = /^http_(\d+)$/.exec(e?.code ?? '')?.[1];
            remoteLog('error', 'translate_failed', e?.message ?? String(e), {
                status: status ? Number(status) : undefined,
                code: e?.code ?? 'unknown',
                duration_ms: Date.now() - started,
                from,
                to,
                text_length: text.length,
            });
        }
        throw e;
    }
}

async function translateStream(text, from, to, options) {
    const { setResult } = options;

    const res = await logosApiFetch('/v1/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, from, to }),
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let target = '';
    let finished = false;

    const handleEvent = (event) => {
        for (const line of event.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '') continue;
            let data;
            try {
                data = JSON.parse(payload);
            } catch {
                continue;
            }
            if (typeof data.delta === 'string') {
                target += data.delta;
                if (setResult) {
                    setResult(target + '_');
                }
            }
            if (data.done) {
                finished = true;
            }
        }
    };

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            buffer = buffer.replaceAll('\r\n', '\n');
            let boundary;
            while ((boundary = buffer.indexOf('\n\n')) !== -1) {
                handleEvent(buffer.slice(0, boundary));
                buffer = buffer.slice(boundary + 2);
            }
        }
        buffer += decoder.decode();
        if (buffer.trim() !== '') {
            handleEvent(buffer);
        }
    } finally {
        reader.releaseLock();
    }

    if (!finished) {
        throw new LogosApiError('stream_interrupted', i18n.t('logos_account.error.stream_interrupted'));
    }
    const result = target.trim();
    if (setResult) {
        setResult(result);
    }
    return result;
}

export * from './info';
