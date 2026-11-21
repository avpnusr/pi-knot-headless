#!/usr/bin/env bash
# Builds preview HTML (GitHub-flavoured Markdown rendered by the GitHub API) for the README screenshots.
# Usage: scripts/preview.sh <outdir>   then: node scripts/shoot.mjs <outdir>  (PNG per page; needs playwright-core + a Chromium)
set -euo pipefail
out="${1:?outdir}"; cd "$(dirname "$0")/.."
node scripts/preview.ts "$out"
css='body{margin:0;padding:28px;background:#f6f8fa;font:15px/1.55 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1f2328}
article{max-width:780px;margin:auto;background:#fff;border:1px solid #d0d7de;border-radius:10px;padding:28px 36px}
h1{font-size:1.7em;margin:.2em 0 .5em}h2{font-size:1.2em;margin-top:1.4em;border-bottom:1px solid #d8dee4;padding-bottom:.25em}h3{font-size:1.02em;margin:1em 0 .3em}
blockquote{margin:.6em 0;padding:.2em 1em;color:#59636e;border-left:.25em solid #d0d7de}
table{border-collapse:collapse;width:100%;margin:.6em 0}th,td{border:1px solid #d0d7de;padding:6px 12px;text-align:left}th{background:#f6f8fa}
code{background:#eff1f3;padding:.15em .4em;border-radius:6px;font-size:90%}ul{padding-left:1.4em}hr{border:0;border-top:1px solid #d8dee4}'
for md in "$out"/*.md; do
	body=$(gh api -X POST markdown -f mode=gfm -f "text=$(cat "$md")" )
	printf '<!doctype html><meta charset="utf-8"><style>%s</style><article>%s</article><script>document.documentElement.dataset.h=document.body.scrollHeight</script>' "$css" "$body" > "${md%.md}.html"
done
ls "$out"
