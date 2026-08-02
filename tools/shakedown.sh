#!/usr/bin/env bash
#
# Re-analyse every crawled site and tally the findings.
#
# No network: `analyse` reads stored HTML, so this re-evaluates every rule
# change against the whole corpus in seconds. That is what makes a
# false-positive shakedown affordable enough to run after every change rather
# than once before release.
#
#   tools/shakedown.sh [work-dir] [--detail]
#
# --detail prints every finding in full, which is what you actually read when
# deciding whether a check is trustworthy. The tally alone tells you nothing
# about whether the findings are *right*.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_ROOT="${1:-${REPO_ROOT}/work}"
SHOW_DETAIL="${2:-}"

if [[ "${WORK_ROOT}" == "--detail" ]]; then
    SHOW_DETAIL="--detail"
    WORK_ROOT="${REPO_ROOT}/work"
fi

if [[ ! -d "${WORK_ROOT}" ]]; then
    echo "no work directory at ${WORK_ROOT}" >&2
    exit 1
fi

TALLY_SCRIPT="$(mktemp)"
trap 'rm -f "${TALLY_SCRIPT}"' EXIT

cat > "${TALLY_SCRIPT}" <<'PYEOF'
import json, sys
REPORT = json.load(open(sys.argv[2]))
SEVERITY = REPORT['summary']['by_severity']
CHECKS = ', '.join(f"{k.split('.')[-1]}x{v}" for k, v in sorted(REPORT['summary']['by_check'].items()))
COVERAGE = '' if REPORT['coverage']['complete'] else ' [partial]'
print(f"{sys.argv[1]:<30} {SEVERITY.get('error',0):>5} {SEVERITY.get('warning',0):>5} "
      f"{SEVERITY.get('opportunity',0):>5}   {CHECKS or '-'}{COVERAGE}")
PYEOF

printf '%-30s %5s %5s %5s   %s\n' site error warn opp 'checks that fired'
printf -- '-%.0s' {1..104}
echo

TOTAL_SITES=0
for SITE_DIR in "${WORK_ROOT}"/*/; do
    SITE_NAME="$(basename "${SITE_DIR}")"
    [[ -f "${SITE_DIR}/pages.jsonl" ]] || continue
    TOTAL_SITES=$((TOTAL_SITES + 1))

    REPORT_JSON="$(mktemp)"
    if node "${REPO_ROOT}/src/cli.ts" analyse --site "${SITE_NAME}" "${SITE_NAME}" \
        --work-dir "${WORK_ROOT}" --json --quiet 2>/dev/null > "${REPORT_JSON}"; then
        python3 "${TALLY_SCRIPT}" "${SITE_NAME}" "${REPORT_JSON}"
    else
        printf '%-30s %5s %5s %5s   ANALYSIS FAILED\n' "${SITE_NAME}" '-' '-' '-'
    fi

    if [[ "${SHOW_DETAIL}" == "--detail" ]]; then
        node "${REPO_ROOT}/src/cli.ts" analyse --site "${SITE_NAME}" "${SITE_NAME}" \
            --work-dir "${WORK_ROOT}" --quiet 2>/dev/null | sed -n '/^## Error/,/^---$/p;/^## Warning/,/^---$/p' | sed 's/^/    /'
    fi
    rm -f "${REPORT_JSON}"
done

echo
echo "${TOTAL_SITES} site(s) analysed."
echo
echo "A tally is not a shakedown. Read the findings — with --detail, or in"
echo "work/<site>/reports/<run-id>/report.md — and decide whether each one is"
echo "real. A check that fires on nothing has not been validated, only untriggered."

exit 0
