# 月谕圣牌交换站

原神「月谕圣牌」玩家交换匹配工具（响应式网页），参考星穹铁道「猫猫糕友人帐」的实现模式。

## 功能

- 以 UID 长期保存档案：服务器 + 昵称 + 22 张圣牌持有数，无需登录（浏览器设备密钥授权，换设备用同一 UID 登记即「接管」，旧数据留档可回滚）
- 发「意向帖」：换出牌 X + 想要（指定牌 Y / 任意缺牌）+ 预计上线时间（选填）；帖子只显示昵称，不显示 UID
- 浏览人填表申请（我提供牌 Z + 上线时间 + 留言）：满足条件即**自动锁定**、帖子从列表隐藏、双方互见 UID，其余申请失效（先到先得，服务端原子保证唯一性）
- 任一方点「确认并更新」：自动更新**自己**的持有（换出 -1、换入 +1），发帖人确认后帖子关闭；对方只收到站内提醒，自行维护记录
- 任何一方随时可取消：帖子回开放重新接受申请
- 双人报告降权 + 管理员处理（驳回 / 关闭帖子）
- 每月 1 日新期提醒、过期记录降权、社区稀缺度（全站缺卡率）、游戏内交换四步引导

## 本地运行

需要 Node.js ≥ 22（使用内置 `node:sqlite`）。

```bash
npm install          # 无第三方依赖，仅为占位
npm test             # 运行 API 行为测试（34 项）
npm run check        # 语法检查
npm start            # 启动本地服务器（默认 http://localhost:8787）
```

环境变量：`PORT`、`DB_FILE`（默认 `data.db`）、`ADMIN_KEY`（默认 `change-me-admin-key`，生产必须修改）。

## 部署（低成本方案）

前端托管在 **GitHub Pages**（github.io，免费），后端用 **Cloudflare Workers + D1**（免费额度内）。

1. **后端**：
   - `wrangler d1 create moon-card-trade`，把返回的 `database_id` 填入 `wrangler.toml`
   - `wrangler d1 execute moon-card-trade --file=server/schema.sql` 初始化表
   - `wrangler deploy` 部署 Worker，并在 Cloudflare 控制台设置环境变量 `ADMIN_KEY`
2. **前端**：
   - 把 `public/` 内容推到 GitHub 仓库（公开仓库），在仓库设置启用 GitHub Pages
   - 在 `public/config.js` 里把 `window.__API_BASE__` 改为你的 Worker 地址（如 `https://moon-card-trade-api.xxx.workers.dev`），本地开发留空即可
   - 注意：GitHub Pages 只托管静态文件，匹配、锁定、确认等都必须走上面的 Worker API
   - Pages 用 GitHub Actions 发布（分支部署只支持 root/docs，不支持 public/）：
     - 仓库 Settings → Pages → Build and deployment → Source 选 **GitHub Actions**
     - 项目已内置 [`.github/workflows/pages.yml`](.github/workflows/pages.yml)，推送 main 后自动构建并发布 `public/`

## 日常更新（上线后）

```bash
# 1. 前端改动：提交并推送，GitHub Pages 自动重新部署
bash scripts/update-site.sh "这次改了什么"

# 2. 后端改动（改过 server/ 或 wrangler.toml 时才需要）：
npx wrangler deploy
```

- 换后端地址 / 域名：只改 `public/config.js` 里的 `window.__API_BASE__`，再执行一次更新脚本即可。

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/players` | 登记 / 接管档案（昵称 + UID + 服务器） |
| PATCH | `/api/players/me/collection` | 更新 22 张持有数量 |
| PATCH | `/api/players/me/nickname` | 修改昵称（30 天冷却，首次修改后 30 天内不可再改） |
| GET | `/api/me` | 我的档案 + 帖子 + 申请 + 提醒 |
| GET | `/api/posts` | 开放意向帖（公开字段不含 UID，`?mine=1` 返回自己帖子） |
| POST | `/api/posts` | 发意向帖 |
| GET | `/api/posts/:id` | 帖子详情（参与者才可见对方 UID） |
| POST | `/api/posts/:id/applications` | 提交申请（满足条件即锁定） |
| POST | `/api/posts/:id/cancel` | 发帖人取消帖子 |
| POST | `/api/applications/:id/confirm` | 确认并更新自己的持有 |
| POST | `/api/applications/:id/cancel` | 申请人取消申请 |
| POST | `/api/reports` | 报告（已完成/信息过期/信息不实/争议） |
| GET/POST | `/api/admin/reports...` | 管理员列表 / 处理（需 `x-admin-key`） |
| GET | `/api/stats` | 全站缺卡率等统计 |
| GET | `/api/cards` | 22 张牌静态数据 |

写操作需 `x-device-id` 请求头（客户端生成并保存在 localStorage），服务端只存 SHA-256 哈希。

## 数据规则

- UID 校验：官服 9 位 1~3 开头；B 服 9 位 5 开头；国际服 6~9 开头（9~10 位）
- 匹配必须同服务器（官服与 B 服不能联机交换）
- 周期 = 每月（幻想真境剧诗每月 1 日重置）；开放/匹配中的帖子在下一期自动过期归档，超过一期末更新的档案降权并提示
- 交换真实性靠「自报 + 持有校验 + 双人报告 + 管理员」保障，平台不验证游戏内是否真实交换
- 昵称创建后 30 天内仅可修改一次，之后每 30 天可改一次；UID 创建后不可修改（多 UID 档案后续支持）

> 若 D1 数据库已建过表（早于昵称冷却功能），需先执行：
> `wrangler d1 execute moon-card-trade --remote --command "ALTER TABLE players ADD COLUMN nickname_updated_at TEXT"`

## 成本估算

- 域名：¥0（github.io）至 ¥50~100/年（自定义域名）
- 后端：Cloudflare 免费额度（Workers 10 万请求/天 + D1 5GB 存储）基本覆盖社区规模，≈ ¥0/月
- 无 ICP 备案要求

> 本站为玩家社区工具，与米哈游无关。
