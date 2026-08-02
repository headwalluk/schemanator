#!/usr/bin/env bash
#
# THROWAWAY M0 helper. Delete when the corpus has served its purpose.
#
# Crawls every URL listed in a file, one after another, into the shared work
# directory. Sequential on purpose: parallel crawls would put several requests
# in flight against one hosting network at once, and the per-host politeness
# queue only governs a single process.
#
#   tools/crawl-batch.sh sites.txt [--fresh] [extra schemanator args...]
#
# sites.txt holds one URL per line; blank lines and # comments are ignored.
#
# Resumes by default. A site already crawled is skipped rather than re-fetched,
# and a site whose sitemap has grown fetches only what is new. Re-crawling a
# corpus from scratch is slow for you and rude to the sites, and there is rarely
# a reason for it -- `analyse` re-runs the checks against stored HTML for free.
#
# --fresh forces a full re-crawl of everything.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SITE_LIST="${1:-}"

if [[ -z "${SITE_LIST}" || ! -f "${SITE_LIST}" ]]; then
    echo "usage: ${0##*/} <site-list-file> [--fresh] [extra schemanator args...]" >&2
    exit 1
fi
shift

RESUME_ARGS=(--resume)
PASSTHROUGH_ARGS=()
for ARGUMENT in "$@"; do
    if [[ "${ARGUMENT}" == "--fresh" ]]; then
        RESUME_ARGS=()
    else
        PASSTHROUGH_ARGS+=("${ARGUMENT}")
    fi
done

if [[ ${#RESUME_ARGS[@]} -eq 0 ]]; then
    echo "--fresh: re-crawling every site from scratch." >&2
fi

if [[ -z "${SCHEMANATOR_CONTACT:-}" ]]; then
    echo "warning: SCHEMANATOR_CONTACT is unset — the User-Agent will not be contactable." >&2
fi

TOTAL_COUNT=0
FAILED_COUNT=0
FAILED_URLS=()

while IFS= read -r RAW_LINE || [[ -n "${RAW_LINE}" ]]; do
    TARGET_URL="${RAW_LINE%%#*}"
    TARGET_URL="${TARGET_URL#"${TARGET_URL%%[![:space:]]*}"}"
    TARGET_URL="${TARGET_URL%"${TARGET_URL##*[![:space:]]}"}"
    [[ -z "${TARGET_URL}" ]] && continue

    TOTAL_COUNT=$((TOTAL_COUNT + 1))
    echo
    echo "############################################################"
    echo "# [${TOTAL_COUNT}] ${TARGET_URL}"
    echo "############################################################"

    # A failure on one site must not abandon the rest of the corpus.
    if ! node "${REPO_ROOT}/src/cli.ts" crawl "${TARGET_URL}" \
        "${RESUME_ARGS[@]+"${RESUME_ARGS[@]}"}" \
        "${PASSTHROUGH_ARGS[@]+"${PASSTHROUGH_ARGS[@]}"}"; then
        EXIT_STATUS=$?
        FAILED_COUNT=$((FAILED_COUNT + 1))
        FAILED_URLS+=("${TARGET_URL} (exit ${EXIT_STATUS})")
        echo "!! ${TARGET_URL} failed with exit ${EXIT_STATUS} — continuing" >&2
    fi
done < "${SITE_LIST}"

echo
echo "############################################################"
echo "# ${TOTAL_COUNT} site(s) attempted, ${FAILED_COUNT} failed"
for FAILED_URL in "${FAILED_URLS[@]+"${FAILED_URLS[@]}"}"; do
    echo "#   ${FAILED_URL}"
done
echo "############################################################"
echo
echo "Now run:  ${REPO_ROOT}/tools/shakedown.sh"

exit 0
