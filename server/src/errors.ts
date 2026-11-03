import type { ContentfulStatusCode } from 'hono/utils/http-status'

export type ErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'user_disabled'
  | 'quota_exhausted'
  | 'global_quota_exhausted'
  | 'rate_limited'
  | 'text_too_long'
  | 'invalid_request'
  | 'not_found'
  | 'upstream_error'
  | 'upstream_busy'
  | 'internal_error'

const STATUS: Record<ErrorCode, ContentfulStatusCode> = {
  unauthorized: 401,
  forbidden: 403,
  user_disabled: 403,
  quota_exhausted: 402,
  global_quota_exhausted: 503,
  rate_limited: 429,
  text_too_long: 400,
  invalid_request: 400,
  not_found: 404,
  upstream_error: 502,
  upstream_busy: 503,
  internal_error: 500
}

export const MESSAGES: Record<ErrorCode, string> = {
  unauthorized: '身份验证失败，请重新登录。',
  forbidden: '当前账户无权访问该资源。',
  user_disabled: '当前账户的翻译服务已被停用。',
  quota_exhausted: '本月翻译额度已用尽，额度将于下月 1 日（北京时间）重置。',
  global_quota_exhausted: '本月服务总额度已用尽，翻译服务暂停至下月 1 日（北京时间）。',
  rate_limited: '请求过于频繁，请稍后再试。',
  text_too_long: '单次翻译的原文不得超过 5000 个字符。',
  invalid_request: '请求格式不正确。',
  not_found: '请求的资源不存在。',
  upstream_error: '上游服务暂时不可用，请稍后再试。',
  upstream_busy: '翻译服务当前繁忙，请稍后重试。',
  internal_error: '服务内部错误，请稍后再试。'
}

export function errorBody(code: ErrorCode, message = MESSAGES[code]) {
  return { error: { code, message } }
}

export function errorResponse(code: ErrorCode, message?: string, headers?: HeadersInit): Response {
  return Response.json(errorBody(code, message), { status: STATUS[code], headers })
}
