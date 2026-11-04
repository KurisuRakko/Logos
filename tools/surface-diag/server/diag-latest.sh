#!/usr/bin/env bash
# Show the newest Surface diagnostics package(s) uploaded by surface-diag.ps1.
#
# Usage: diag-latest.sh [-l] [-n N] [APP]
#   APP   application subdirectory (default: all applications)
#   -n N  unpack and print the newest N packages (default 1)
#   -l    only list the newest 15 packages
# Packages live in ~/diag/surface/<app>/<timestamp>-<reason>.zip; each one is
# unpacked into a new temporary directory, which is kept for further reading.
set -euo pipefail

ROOT="${DIAG_ROOT:-$HOME/diag/surface}"
count=1
list_only=0
while getopts "ln:h" opt; do
  case "$opt" in
    l) list_only=1 ;;
    n) count="$OPTARG" ;;
    h) sed -n '2,9p' "$0"; exit 0 ;;
    *) exit 2 ;;
  esac
done
shift $((OPTIND - 1))
app="${1:-}"
dir="$ROOT${app:+/$app}"

if [[ ! -d "$dir" ]]; then
  echo "No packages: $dir does not exist." >&2
  exit 1
fi

# Newest first by the timestamp in the file name (collection time on the Surface);
# hidden .part files are uploads still in progress.
mapfile -t pkgs < <(find "$dir" -type f -name '*.zip' ! -name '.*' -printf '%f\t%p\n' | sort -r | cut -f2-)
if [[ ${#pkgs[@]} -eq 0 ]]; then
  echo "No packages under $dir." >&2
  exit 1
fi

if [[ $list_only -eq 1 ]]; then
  for p in "${pkgs[@]:0:15}"; do
    printf '%s  %8s  %s\n' "$(date -r "$p" '+%F %T')" "$(du -h "$p" | cut -f1)" "${p#$ROOT/}"
  done
  exit 0
fi

pretty() { if command -v jq >/dev/null; then jq . "$1"; else cat "$1"; fi; }

for p in "${pkgs[@]:0:$count}"; do
  out="$(mktemp -d "${TMPDIR:-/tmp}/surface-diag.XXXXXX")"
  # Windows PowerShell 5.1 Compress-Archive writes backslash separators; normalise them
  python3 -I -c 'import sys,zipfile,os
z=zipfile.ZipFile(sys.argv[1]); out=sys.argv[2]
for i in z.infolist():
    n=i.filename.replace("\\","/")
    if n.startswith("/") or ".." in n.split("/"): continue
    d=os.path.join(out,n)
    if n.endswith("/"): os.makedirs(d,exist_ok=True); continue
    os.makedirs(os.path.dirname(d),exist_ok=True)
    open(d,"wb").write(z.read(i))' "$p" "$out"
  echo "=================================================================="
  echo "Package: ${p#$ROOT/}"
  echo "Unpacked: $out"
  echo "------------------------------------------------------------------ summary.json"
  pretty "$out/summary.json"

  if [[ -f "$out/events/app-crash-events.json" ]] && command -v jq >/dev/null; then
    n="$(jq 'length' "$out/events/app-crash-events.json")"
    if [[ "$n" -gt 0 ]]; then
      echo "------------------------------------------------------------------ crash events ($n)"
      jq -r '.[] | "\(.time)  id=\(.id)  counts=\(.countsAsCrash)  \(.message | split("\n")[0:6] | join(" | "))"' \
        "$out/events/app-crash-events.json" | head -n 20
    fi
  fi
  if [[ -f "$out/events/display-kernel-events.json" ]] && command -v jq >/dev/null; then
    n="$(jq '(.events | length) + (.werKernelReports | length)' "$out/events/display-kernel-events.json")"
    if [[ "$n" -gt 0 ]]; then
      echo "------------------------------------------------------------------ display/kernel ($n)"
      jq -r '(.events[] | "\(.time)  \(.log)/\(.id)  \(.provider)  \(.message | split("\n")[0])"),
             (.werKernelReports[] | "\(.time)  WER  \(.report)")' \
        "$out/events/display-kernel-events.json" | head -n 20
    fi
  fi
  if [[ -d "$out/wer" ]]; then
    for w in "$out"/wer/*.wer.txt; do
      [[ -e "$w" ]] || continue
      echo "------------------------------------------------------------------ $(basename "$w")"
      grep -E '^(EventType|AppName|AppPath|Sig\[[0-9]+\]\.(Name|Value)|FriendlyEventName)=' "$w" | head -n 24 || true
    done
  fi
  if [[ -s "$out/logs/panic.log" ]]; then
    echo "------------------------------------------------------------------ panic.log (last 60 lines)"
    tail -n 60 "$out/logs/panic.log"
  fi
  for log in "$out"/logs/*.log; do
    [[ -e "$log" ]] || continue
    [[ "$(basename "$log")" == panic.log ]] && continue
    echo "------------------------------------------------------------------ $(basename "$log") ERROR/WARN (last 15)"
    grep -E '\[(ERROR|WARN)\]' "$log" | tail -n 15 || true
    echo "------------------------------------------------------------------ $(basename "$log") (last 25 lines)"
    tail -n 25 "$log"
  done
  echo
done
