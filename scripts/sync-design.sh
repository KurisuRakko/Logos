#!/usr/bin/env bash
# scripts/sync-design.sh —— 把 Rakko Design 设计系统同步成项目里的「外来件」vendor/rakko-design/。
#
# 用法：
#   scripts/sync-design.sh [ref]        # ref 默认 main，可给分支 / tag / commit
#
# 源（脚本自己不改任何上游文件，只读）：
#   * RAKKO_DESIGN_DIR=<本地目录> 时直接用它，**不联网**（本机快照 / 离线审核用这个）；
#   * 否则浅克隆 https://github.com/KurisuRakko/Rakko-Design。
#   commit 解析优先级：RAKKO_DESIGN_COMMIT > git rev-parse HEAD（.git 是目录或 worktree 的 .git 文件都认） > <源>/COMMIT 文件 > unknown。
#   RAKKO_DESIGN_COMMIT=<hash> 可在本地快照没有 .git / COMMIT 时兜底。
#
# 产物（vendor/rakko-design/，只能由本脚本生成，不许手改）：
#   design-system/src/*     逐字拷贝（tokens / glass / state-layer / ripple / ripple-geometry / ripple.d.ts）
#   react/src/**            逐字拷贝，排除 *.test.ts、*.test.tsx、vitest.setup.ts
#   tokens.generated.css    生成：scaffold.html 第一个 <style> 的 :root {…} 与
#                           [data-theme='dark'] {…} 两段原文（上游 tokens.css 是 Tailwind v4 的
#                           @theme，浏览器不认；深色值只存在于 scaffold 的消费方主题层）
#   VERSION                 commit / synced / source / resolved_from / ref
#   README.md               三行说明（固定文本）
#
# 幂等：同一 commit 连跑两次零 diff（synced 时间保留首次写入的值）；
#       上游删掉的文件会从 vendor 删掉。staging 准备好才上线，任何一步失败都不覆盖旧文件。
# 依赖：bash、git（可选）、find、cmp、node（只用标准库）。零第三方包。
set -euo pipefail

REF="${1:-main}"
URL="https://github.com/KurisuRakko/Rakko-Design"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
DEST="$ROOT/vendor/rakko-design"

CLONE_TMP=""
STAGE=""
cleanup() {
  [ -n "$STAGE" ] && rm -rf "$STAGE"
  [ -n "$CLONE_TMP" ] && rm -rf "$CLONE_TMP"
  return 0
}
trap cleanup EXIT

# ------------------------------------------------------------------ 1. 取源
if [ -n "${RAKKO_DESIGN_DIR:-}" ]; then
  if [ ! -d "$RAKKO_DESIGN_DIR" ]; then
    echo "[sync-design] 错误：RAKKO_DESIGN_DIR=$RAKKO_DESIGN_DIR 不存在" >&2
    exit 2
  fi
  SRC="$(cd "$RAKKO_DESIGN_DIR" && pwd)"
  echo "[sync-design] 源：本地目录 $SRC（不联网）"
else
  command -v git >/dev/null 2>&1 || { echo "[sync-design] 错误：需要 git" >&2; exit 2; }
  CLONE_TMP="$(mktemp -d)"
  SRC="$CLONE_TMP/Rakko-Design"
  echo "[sync-design] 源：$URL @ $REF（浅克隆到临时目录）"
  if ! git clone --depth 1 --branch "$REF" "$URL" "$SRC" >&2; then
    echo "[sync-design] --branch $REF 浅克隆失败，改为完整克隆 + checkout（ref 可能是 commit）" >&2
    rm -rf "$SRC"
    git clone "$URL" "$SRC" >&2
    git -C "$SRC" checkout --detach "$REF" >&2
  fi
fi

DS="$SRC/design-system"
REACT="$SRC/react"
SCAFFOLD="$DS/templates/scaffold.html"

for f in "$DS/src/glass.css" "$DS/src/state-layer.css" "$DS/src/ripple.js" \
         "$DS/src/ripple-geometry.js" "$DS/src/ripple.d.ts" "$DS/src/tokens.css" \
         "$SCAFFOLD" "$REACT/src/index.ts" "$REACT/src/styles.css"; do
  if [ ! -f "$f" ]; then
    echo "[sync-design] 错误：源里缺少 ${f#"$SRC"/}" >&2
    exit 2
  fi
done

# ------------------------------------------------------------------ 2. commit
if [ -n "${RAKKO_DESIGN_COMMIT:-}" ]; then
  HASH="$RAKKO_DESIGN_COMMIT"; HASH_FROM="env:RAKKO_DESIGN_COMMIT"
elif [ -e "$SRC/.git" ] && command -v git >/dev/null 2>&1; then
  HASH="$(git -C "$SRC" rev-parse HEAD)"; HASH_FROM="git rev-parse HEAD"
elif [ -f "$SRC/COMMIT" ]; then
  HASH="$(tr -d '[:space:]' < "$SRC/COMMIT")"; HASH_FROM="$SRC/COMMIT"
else
  HASH="unknown"; HASH_FROM="未解析（本地快照没有 .git，也没有 COMMIT 文件）"
fi

# ------------------------------------------------------------------ 3. staging（失败不覆盖旧文件）
STAGE="$(mktemp -d)"
mkdir -p "$STAGE/design-system/src" "$STAGE/react/src"

copy_tree() {
  # copy_tree <源根> <staging 根> <排除测试 y/n>
  local from="$1" to="$2" skip_tests="$3" rel
  (cd "$from" && find . -type f -print0) | while IFS= read -r -d '' rel; do
    rel="${rel#./}"
    if [ "$skip_tests" = "y" ]; then
      case "$rel" in
        *.test.ts | *.test.tsx | vitest.setup.ts) continue ;;
      esac
    fi
    mkdir -p "$to/$(dirname "$rel")"
    cp -p "$from/$rel" "$to/$rel"
  done
}

copy_tree "$DS/src" "$STAGE/design-system/src" n
copy_tree "$REACT/src" "$STAGE/react/src" y

for d in "$STAGE/design-system/src" "$STAGE/react/src"; do
  if [ -z "$(find "$d" -type f -print0 | tr -d '\0')" ]; then
    echo "[sync-design] 错误：staging 里 $d 是空的，源结构可能变了" >&2
    exit 3
  fi
done

node - "$SCAFFOLD" "$HASH" "$STAGE/tokens.generated.css" <<'NODE'
// 从 scaffold.html 的第一个 <style> 块里提取 :root 与 [data-theme='dark'] 两段原文，
// 拼成浏览器直接认的 tokens.generated.css。任何一块缺失/为空 → 非零退出，绝不写出空文件。
import { readFileSync, writeFileSync } from 'node:fs'

const [scaffoldPath, hash, outPath] = process.argv.slice(2)
const fail = (msg) => {
  console.error(`[sync-design] 提取失败：${msg}`)
  process.exit(3)
}

let html
try {
  html = readFileSync(scaffoldPath, 'utf8')
} catch (err) {
  fail(`读不到 ${scaffoldPath}（${err.message}）`)
}

const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map((m) => m[1])
if (styleBlocks.length === 0) fail('scaffold.html 里找不到任何 <style> 块')
const first = styleBlocks[0]

const rootMatch = first.match(/:root\s*\{([^{}]*)\}/)
const darkMatch = first.match(/\[data-theme\s*=\s*['"]dark['"]\]\s*\{([^{}]*)\}/)

const inner = (match, name, mustHave) => {
  if (!match) fail(`scaffold.html 第一个 <style> 里找不到 ${name} 块`)
  const body = match[1].replace(/^\s*\n/, '').replace(/\s*$/, '')
  if (!body.trim()) fail(`${name} 块是空的`)
  for (const token of mustHave) {
    if (!body.includes(token)) fail(`${name} 块里没有 ${token}，scaffold 结构可能变了`)
  }
  return body
}

const rootBody = inner(rootMatch, ':root', [
  '--color-neutral-1',
  '--color-neutral-9',
  '--color-paper',
  '--color-border',
  '--font-serif',
])
const darkBody = inner(darkMatch, "[data-theme='dark']", ['--color-neutral-1', '--color-paper'])

const out =
  `/* generated by scripts/sync-design.sh from Rakko-Design@${hash} — do not edit */\n` +
  `/* 浅色 token：scaffold.html 第一个 <style> 的 :root 块，原文照抄 */\n` +
  `:root {\n${rootBody}\n}\n\n` +
  `/* 深色 token：同一 <style> 的 [data-theme='dark'] 块，原文照抄 */\n` +
  `[data-theme='dark'] {\n${darkBody}\n}\n`

if (!out.includes('--color-neutral-1')) fail('生成结果里没有 --color-neutral-1')
writeFileSync(outPath, out)
NODE

if [ ! -s "$STAGE/tokens.generated.css" ]; then
  echo "[sync-design] 错误：生成的 tokens.generated.css 为空，未覆盖旧文件" >&2
  exit 3
fi

# ------------------------------------------------------------------ 4. VERSION / README
now_syd() { TZ=Australia/Sydney date +%Y-%m-%dT%H:%M:%S%:z; }
SYNCED=""
if [ -f "$DEST/VERSION" ] && grep -qx "commit=$HASH" "$DEST/VERSION"; then
  SYNCED="$(sed -n 's/^synced=//p' "$DEST/VERSION" | head -n 1)"
fi
[ -n "$SYNCED" ] || SYNCED="$(now_syd)"
{
  echo "commit=$HASH"
  echo "synced=$SYNCED"
  echo "source=$URL"
  echo "resolved_from=$HASH_FROM"
  echo "ref=$REF"
} > "$STAGE/VERSION"

cat > "$STAGE/README.md" <<'MD'
# 外来件 · do not edit
这是 Rakko Design 的只读副本：由 `pnpm sync-design`（scripts/sync-design.sh）从上游同步，**不要手改**——类型/构建问题请在应用侧 tsconfig / vite.config.ts 解决。
同步：`RAKKO_DESIGN_DIR=<上游快照> pnpm sync-design`（离线，本机审核用这个）或直接 `pnpm sync-design`（浅克隆）。
版本：见 `VERSION`（commit / synced / source / resolved_from / ref）；上游 commit 变了就重跑同步。
MD

# ------------------------------------------------------------------ 5. 上线（未变不写，上游删掉的跟着删）
mkdir -p "$DEST"

(cd "$STAGE" && find . -type f -print0) | while IFS= read -r -d '' rel; do
  rel="${rel#./}"
  src="$STAGE/$rel"
  dst="$DEST/$rel"
  mkdir -p "$(dirname "$dst")"
  if [ -f "$dst" ] && cmp -s "$src" "$dst"; then
    echo "[sync-design] 未变：$rel"
  else
    cp -p "$src" "$dst"
    echo "[sync-design] 写入：$rel"
  fi
done

(cd "$DEST" && find . -type f -print0) | while IFS= read -r -d '' rel; do
  rel="${rel#./}"
  if [ ! -f "$STAGE/$rel" ]; then
    rm -f "$DEST/$rel"
    echo "[sync-design] 删除（上游已无）：$rel"
  fi
done
find "$DEST" -type d -empty -delete
removed="$(find "$DEST" -type f | wc -l)"

echo "[sync-design] 完成：Rakko-Design@$HASH（$HASH_FROM）→ vendor/rakko-design/（$removed 个文件）"

# ------------------------------------------------------------------ 6. 合规检查（项目没有 check-design.mjs 时跳过）
if [ -f "$ROOT/scripts/check-design.mjs" ] && ! node "$ROOT/scripts/check-design.mjs"; then
  echo "[sync-design] check-design.mjs 未通过：上述问题需人工修（文件已经更新，方便看 diff）" >&2
  exit 1
fi
