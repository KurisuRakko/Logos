import { logosMachineTranslate } from '../../../utils/logos_account';
import { remoteLog } from '../../../utils/remote_log';

// Baidu Translate through logos-api (POST /v1/mt, provider=baidu); no user key needed
export async function translate(text, from, to) {
    const started = Date.now();
    try {
        const result = await logosMachineTranslate('baidu', text, from, to);
        remoteLog('info', 'mt_ok', '', {
            provider: 'baidu',
            duration_ms: Date.now() - started,
            text_length: text.length,
        });
        return result.trim();
    } catch (e) {
        // only metadata; the text itself never leaves the client through logs
        if (e?.code !== 'not_logged_in') {
            remoteLog('error', 'mt_failed', e?.message ?? String(e), {
                provider: 'baidu',
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

export * from './info';
