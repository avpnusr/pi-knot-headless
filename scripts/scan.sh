#!/usr/bin/env bash
# Scans tracked files for secrets and personal data before anything is pushed (this repo is public).
# Extra deny patterns (your hostnames, ids, paths) go into an untracked `.scan-deny` file, one regex per line.
set -u
cd "$(git rev-parse --show-toplevel)"
fail=0
hit() { echo "scan: $1"; fail=1; }

files=$(git ls-files | grep -v -E '^(scripts/scan\.sh|scripts/scan-allow\.txt)$' | grep -v -E '\.(png|jpg|jpeg|gif)$')
code_files=$(echo "$files" | grep -v -E '\.test\.ts$|fakepi\.ts$|^docs/plan\.md$')   # tests and plan contain fake tokens on purpose

tokens='knot_[A-Za-z0-9]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{5,}|BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}'
[ -n "$code_files" ] && echo "$code_files" | xargs grep -n -E "$tokens" 2>/dev/null | while read -r l; do hit "possible secret: $l"; done | grep . && fail=1

uuid='[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
allow=$(grep -v '^#' scripts/scan-allow.txt 2>/dev/null | grep . | paste -sd'|')
echo "$files" | xargs grep -n -o -i -E "$uuid" 2>/dev/null | while IFS=: read -r f n u; do
	if [ -z "$allow" ] || ! echo "$u" | grep -q -i -E "^($allow)$"; then echo "scan: unlisted UUID $u in $f:$n"; fi
done | grep . && fail=1

if [ -f .scan-deny ]; then
	while read -r re; do
		[ -z "$re" ] && continue
		echo "$files" | xargs grep -n -i -E "$re" 2>/dev/null | while read -r l; do hit "denied pattern /$re/: $l"; done | grep . && fail=1
	done < .scan-deny
fi
[ "$fail" = 0 ] && echo "scan: clean"
exit $fail
