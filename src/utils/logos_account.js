import { invoke } from '@tauri-apps/api';
import i18n from 'i18next';

import { remoteLog } from './remote_log';
import { getSnapshot } from './store';

const DEFAULT_LOGOS_API_BASE = 'https://logos-api.rakko.cn';

// `logos_api_base` in config.json points the client at a development Worker
export function logosApiBase() {
    const base = getSnapshot('logos_api_base');
    return typeof base === 'string' && base.trim() !== '' ? base.trim().replace(/\/+$/, '') : DEFAULT_LOGOS_API_BASE;
}

// Thrown for every failure the user should see; message is already localized
export class LogosApiError extends Error {
    constructor(code, message) {
        super(message);
        this.code = code;
    }

    // the translate window shows e.toString(); keep the "Error: " prefix out of it
    toString() {
        return this.message;
    }
}

// Valid access token from the Rust side (refreshed there when close to expiry), or a
// LogosApiError when the user is signed out
export async function getLogosAccessToken() {
    let token;
    try {
        token = await invoke('logos_account_token');
    } catch (e) {
        // the Rust side refreshes the token here, so this is where a failed renewal shows up
        remoteLog('warn', 'account_token_failed', String(e));
        throw new LogosApiError('network_error', String(e));
    }
    if (!token) {
        throw new LogosApiError('not_logged_in', i18n.t('logos_account.error.not_logged_in'));
    }
    return token;
}

export function formatResetDate(resetsAt) {
    const date = new Date(resetsAt);
    if (Number.isNaN(date.getTime())) {
        return String(resetsAt ?? '');
    }
    return date.toLocaleString(i18n.language.replace('_', '-'), { dateStyle: 'medium', timeStyle: 'short' });
}

const ERROR_KEYS = [
    'unauthorized',
    'forbidden',
    'user_disabled',
    'quota_exhausted',
    'global_quota_exhausted',
    'rate_limited',
    'text_too_long',
    'upstream_error',
    'upstream_busy',
];

// Turn a non-2xx logos-api response ({error: {code, message}}) into a LogosApiError
export async function readLogosApiError(res) {
    let body = null;
    try {
        body = await res.json();
    } catch {
        // non-JSON body, fall through to the status-based message
    }
    const code = body?.error?.code ?? `http_${res.status}`;
    if (code === 'quota_exhausted') {
        let resetsAt = null;
        try {
            resetsAt = (await fetchLogosQuota()).resets_at;
        } catch {
            // the quota lookup is only for the reset date
        }
        const message = resetsAt
            ? i18n.t('logos_account.error.quota_exhausted', { date: formatResetDate(resetsAt) })
            : i18n.t('logos_account.error.quota_exhausted_no_date');
        return new LogosApiError(code, message);
    }
    if (ERROR_KEYS.includes(code)) {
        return new LogosApiError(code, i18n.t(`logos_account.error.${code}`));
    }
    return new LogosApiError(code, body?.error?.message ?? i18n.t('logos_account.error.http', { status: res.status }));
}

export async function logosApiFetch(path, init = {}) {
    const token = await getLogosAccessToken();
    let res;
    try {
        res = await window.fetch(`${logosApiBase()}${path}`, {
            ...init,
            headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
        });
    } catch (e) {
        throw new LogosApiError('network_error', i18n.t('logos_account.error.network', { detail: String(e) }));
    }
    if (!res.ok) {
        throw await readLogosApiError(res);
    }
    return res;
}

// {limit_micro, used_micro, remaining_ratio, resets_at}
export async function fetchLogosQuota() {
    try {
        const res = await logosApiFetch('/v1/quota');
        return await res.json();
    } catch (e) {
        if (e?.code !== 'not_logged_in') {
            remoteLog('warn', 'account_quota_failed', e?.message ?? String(e), { code: e?.code });
        }
        throw e;
    }
}

const MT_ERROR_KEYS = [
    'bad_request',
    'text_too_long',
    'unsupported_language',
    'quota_exhausted',
    'user_disabled',
    'provider_not_configured',
    'upstream_error',
];

// POST /v1/mt: plain machine translation billed against the account's monthly free allowance.
// provider is 'baidu' or 'fallback'; from/to are Logos language keys. Errors come back flat as
// {error, message}; unhandled server exceptions still use the nested {error: {code, message}}.
export async function logosMachineTranslate(provider, text, from, to) {
    let token;
    try {
        token = await getLogosAccessToken();
    } catch (e) {
        if (e?.code === 'not_logged_in') {
            throw new LogosApiError('not_logged_in', i18n.t('logos_account.mt_error.not_logged_in'));
        }
        throw e;
    }
    let res;
    try {
        res = await window.fetch(`${logosApiBase()}/v1/mt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ provider, text, from, to }),
        });
    } catch (e) {
        throw new LogosApiError('network_error', i18n.t('logos_account.mt_error.network', { detail: String(e) }));
    }
    let body = null;
    try {
        body = await res.json();
    } catch {
        // non-JSON body, handled by the status checks below
    }
    if (!res.ok) {
        const error = body?.error;
        const code = (typeof error === 'string' ? error : error?.code) ?? `http_${res.status}`;
        if (MT_ERROR_KEYS.includes(code)) {
            throw new LogosApiError(code, i18n.t(`logos_account.mt_error.${code}`));
        }
        if (code === 'unauthorized' || code === 'rate_limited') {
            throw new LogosApiError(code, i18n.t(`logos_account.error.${code}`));
        }
        throw new LogosApiError(code, i18n.t('logos_account.mt_error.http', { status: res.status }));
    }
    if (typeof body?.text !== 'string') {
        throw new LogosApiError('bad_response', i18n.t('logos_account.mt_error.http', { status: res.status }));
    }
    return body.text;
}
