// Cloudflare Worker 入口（ES Module 格式）：wrangler deploy 时使用
import { createApp } from './app.js';

export default {
  async fetch(request, env) {
    const app = createApp({ db: env.DB, adminKey: env.ADMIN_KEY || 'change-me-admin-key' });
    return app.handle(request);
  },
};
