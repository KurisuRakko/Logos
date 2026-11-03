import { Button, IconButton, Snackbar, TopBar, useRippleFeedback, useSnackbar, useTheme } from '@rakko/react'
import { useCallback, useEffect, useState } from 'react'

import { LoginError, completeLoginFromHash, hasSession, signOut, startLogin } from './auth'
import { Dashboard } from './Dashboard'
import { MoonIcon, SignOutIcon, SunIcon } from './icons'

type Phase =
  | { kind: 'booting' }
  | { kind: 'signed-out'; error?: string }
  | { kind: 'forbidden' }
  | { kind: 'ready' }

// 登录回跳只处理一次：StrictMode 下 effect 会跑两遍，第二遍不能把正在交换的登录码当成「没有回跳」
let boot: Promise<Phase> | null = null
function bootOnce(): Promise<Phase> {
  boot ??= completeLoginFromHash().then(
    () => (hasSession() ? { kind: 'ready' } : { kind: 'signed-out' }),
    (err: unknown) => ({
      kind: 'signed-out',
      error: err instanceof LoginError ? err.message : '登录失败，请重新登录。',
    }),
  )
  return boot
}

export function App() {
  useRippleFeedback()
  const [phase, setPhase] = useState<Phase>({ kind: 'booting' })
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let alive = true
    void bootOnce().then((next) => {
      if (alive) setPhase(next)
    })
    return () => {
      alive = false
    }
  }, [])

  const handleSignOut = useCallback(() => {
    signOut()
    setPhase({ kind: 'signed-out' })
  }, [])

  const onAuthLost = useCallback(() => {
    signOut()
    setPhase({ kind: 'signed-out', error: '登录已过期，请重新登录。' })
  }, [])
  const onForbidden = useCallback(() => setPhase({ kind: 'forbidden' }), [])

  return (
    <>
      <TopBar.Root reveal="scroll" className="la-topbar">
        <TopBar.Title>
          <span className="la-brand">Logos</span>
          <span className="la-brand__sub">额度管理</span>
        </TopBar.Title>
        <TopBar.Actions aria-label="页面操作">
          <ThemeToggle />
          {phase.kind === 'ready' || phase.kind === 'forbidden' ? (
            <IconButton aria-label="退出登录" onClick={handleSignOut}>
              <SignOutIcon />
            </IconButton>
          ) : null}
        </TopBar.Actions>
      </TopBar.Root>

      <main className="la-main">
        {phase.kind === 'booting' ? <p className="la-muted la-center">正在验证登录状态…</p> : null}
        {phase.kind === 'signed-out' ? <SignIn error={phase.error} /> : null}
        {phase.kind === 'forbidden' ? <Forbidden onSignOut={handleSignOut} /> : null}
        {phase.kind === 'ready' ? (
          <Dashboard
            key={reloadKey}
            onAuthLost={onAuthLost}
            onForbidden={onForbidden}
            onReload={() => setReloadKey((k) => k + 1)}
          />
        ) : null}
      </main>

      <Toasts />
    </>
  )
}

function ThemeToggle() {
  const { resolved, setTheme } = useTheme()
  const dark = resolved === 'dark'
  return (
    <IconButton
      aria-label={dark ? '切换到浅色模式' : '切换到深色模式'}
      onClick={() => setTheme(dark ? 'light' : 'dark')}
    >
      {dark ? <SunIcon /> : <MoonIcon />}
    </IconButton>
  )
}

function SignIn({ error }: { error?: string }) {
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const go = () => {
    setPending(true)
    setFailure(null)
    startLogin().catch(() => {
      setPending(false)
      setFailure('无法发起登录：当前浏览器环境不支持所需的加密接口。')
    })
  }

  return (
    <section className="la-card la-gate" aria-labelledby="sign-in-title">
      <h1 id="sign-in-title" className="la-gate__title">
        登录 Logos 管理页
      </h1>
      <p className="la-gate__body">
        本页面用于查看与调整 Logos 翻译服务的用户额度，仅限管理员账号访问。请使用 Rakko 账号登录。
      </p>
      {error || failure ? (
        <p className="la-gate__error" role="alert">
          {failure ?? error}
        </p>
      ) : null}
      <Button variant="primary" onClick={go} disabled={pending}>
        {pending ? '正在跳转…' : '使用 Rakko 账号登录'}
      </Button>
    </section>
  )
}

function Forbidden({ onSignOut }: { onSignOut: () => void }) {
  return (
    <section className="la-card la-gate" aria-labelledby="forbidden-title">
      <h1 id="forbidden-title" className="la-gate__title">
        当前账号无管理权限
      </h1>
      <p className="la-gate__body">
        管理页仅对管理员开放。如需使用其他账号，请先退出登录后重新登录。
      </p>
      <Button variant="secondary" onClick={onSignOut}>
        退出登录
      </Button>
    </section>
  )
}

function Toasts() {
  const { toasts } = useSnackbar()
  return (
    <Snackbar.Viewport>
      {toasts.map((toast) => (
        <Snackbar.Root key={toast.id} toast={toast}>
          <Snackbar.Title />
        </Snackbar.Root>
      ))}
    </Snackbar.Viewport>
  )
}
