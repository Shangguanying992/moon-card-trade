#!/usr/bin/env bash
# 一键更新上线：提交并推送 main，GitHub Pages 会自动重新部署前端。
# 用法：bash scripts/update-site.sh "更新说明"
# 注意：如果本次改了 server/ 或 wrangler.toml，还要再执行 npx wrangler deploy 更新后端。
set -e
cd "$(dirname "$0")/.."
MSG="${1:-站点更新}"
git add -A
git commit -m "$MSG"
git push origin main
echo "已推送 main，GitHub Pages 将自动重新部署（约 1~2 分钟生效）"
