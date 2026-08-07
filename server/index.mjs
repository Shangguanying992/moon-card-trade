// Cloudflare Worker 入口（ES Module 格式）：wrangler deploy 时使用
import { createApp } from './app.js';

export default {
  async fetch(request, env) {
    const app = createApp({ db: env.DB, adminKey: env.ADMIN_KEY || 'change-me-admin-key' });
    return app.handle(request);
  },
  // 每 5 分钟预热一次，减少空闲后首个请求的冷启动延迟
  async scheduled(event, env, ctx) {
    const app = createApp({ db: env.DB, adminKey: env.ADMIN_KEY || 'change-me-admin-key' });
    await app.handle(new Request('https://internal/api/cards'));
  },
};
