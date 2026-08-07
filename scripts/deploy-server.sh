#!/usr/bin/env bash
# 在 Linux 服务器（Ubuntu/Debian）上部署后端 API：
#   bash scripts/deploy-server.sh <服务器用户>@<服务器IP>
# 部署后 API 地址为 http://<服务器IP>:8787，把该地址填进 public/config.js
set -euo pipefail

HOST="${1:?用法: bash scripts/deploy-server.sh 用户@IP}"
APP_DIR="/opt/moon-card-trade"

echo "==> 检查服务器上 Node.js ≥ 22"
ssh "$HOST" "node --version || echo NEED_NODE"

echo "==> 上传代码"
ssh "$HOST" "sudo mkdir -p $APP_DIR && sudo chown \$(whoami) $APP_DIR"
scp -r server cards.json "$HOST:$APP_DIR/"

echo "==> 安装 systemd 服务"
scp deploy/moon-card-trade.service "$HOST:/tmp/moon-card-trade.service"
ssh "$HOST" "sudo cp /tmp/moon-card-trade.service /etc/systemd/system/ && sudo systemctl daemon-reload && sudo systemctl enable --now moon-card-trade && sleep 1 && curl -s http://127.0.0.1:8787/api/cards | head -c 80"

echo ""
echo "==> 完成。请修改 /etc/systemd/system/moon-card-trade.service 里的 ADMIN_KEY 后执行:"
echo "    sudo systemctl restart moon-card-trade"
echo "    并确认服务器防火墙/安全组放行 8787 端口"
