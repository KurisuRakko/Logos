import { fetch } from '@tauri-apps/api/http';

import { logosMachineTranslate } from '../../../utils/logos_account';
import { remoteLog } from '../../../utils/remote_log';
import { Language } from './info';

// seconds; the web endpoint is unreachable from some networks and would otherwise hang
const GOOGLE_TIMEOUT = 4;

// Google language code -> Logos language key for the logos-api fallback. Where several keys
// share a code (pt, no) the first one listed in Language wins.
const LOGOS_LANGUAGE_KEY = {};
for (const [key, code] of Object.entries(Language)) {
    if (!(code in LOGOS_LANGUAGE_KEY)) {
        LOGOS_LANGUAGE_KEY[code] = key;
    }
}

// Google's web endpoint first; when it fails and the user is signed in to a Logos account,
// logos-api (POST /v1/mt, provider=fallback) answers instead. If both fail the Google error is
// what the user sees.
export async function translate(text, from, to, options = {}) {
    let googleError;
    try {
        return await translateWithGoogle(text, from, to, options);
    } catch (e) {
        googleError = e;
    }
    const logosFrom = LOGOS_LANGUAGE_KEY[from];
    const logosTo = LOGOS_LANGUAGE_KEY[to];
    if (logosFrom === undefined || logosTo === undefined) {
        throw googleError;
    }
    const started = Date.now();
    try {
        const result = await logosMachineTranslate('fallback', text, logosFrom, logosTo);
        // only metadata; the text itself never leaves the client through logs
        remoteLog('info', 'google_fallback_ok', '', {
            duration_ms: Date.now() - started,
            text_length: text.length,
        });
        return result.trim();
    } catch (e) {
        if (e?.code !== 'not_logged_in') {
            remoteLog('warn', 'google_fallback_failed', e?.message ?? String(e), {
                code: e?.code ?? 'unknown',
                duration_ms: Date.now() - started,
                from: logosFrom,
                to: logosTo,
                text_length: text.length,
            });
        }
        throw googleError;
    }
}

async function translateWithGoogle(text, from, to, options) {
    const { config = {} } = options;

    let { custom_url } = config;

    if (custom_url === undefined || custom_url === '') {
        custom_url = 'https://translate.google.com';
    }
    if (!custom_url.startsWith('http')) {
        custom_url = 'https://' + custom_url;
    }

    let res = await fetch(
        `${custom_url}/translate_a/single?dt=at&dt=bd&dt=ex&dt=ld&dt=md&dt=qca&dt=rw&dt=rm&dt=ss&dt=t`,
        {
            method: 'GET',
            timeout: GOOGLE_TIMEOUT,
            headers: { 'content-type': 'application/json' },
            query: {
                client: 'gtx',
                sl: from,
                tl: to,
                hl: to,
                ie: 'UTF-8',
                oe: 'UTF-8',
                otf: '1',
                ssel: '0',
                tsel: '0',
                kc: '7',
                q: text,
            },
        }
    );
    if (res.ok) {
        let result = res.data;
        if (!Array.isArray(result) || !Array.isArray(result[0])) {
            throw 'Unexpected response from Google Translate';
        }
        // 词典模式
        if (result[1]) {
            let target = { pronunciations: [], explanations: [], associations: [], sentence: [] };
            // 发音
            if (result[0][1][3]) {
                target.pronunciations.push({ symbol: result[0][1][3], voice: '' });
            }
            // 释义
            for (let i of result[1]) {
                target.explanations.push({
                    trait: i[0],
                    explains: i[2].map((x) => {
                        return x[0];
                    }),
                });
            }
            // 例句
            if (result[13]) {
                for (let i of result[13][0]) {
                    target.sentence.push({ source: i[0] });
                }
            }
            return target;
        } else {
            // 翻译模式
            let target = '';
            for (let r of result[0]) {
                if (r[0]) {
                    target = target + r[0];
                }
            }
            return target.trim();
        }
    } else {
        throw `Http Request Error\nHttp Status: ${res.status}\n${JSON.stringify(res.data)}`;
    }
}

export * from './info';
