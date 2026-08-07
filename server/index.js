'use strict';
// Cloudflare Worker 入口：wrangler dev / deploy 时使用
const { createApp } = require('./app.js');

module.exports = {
  async fetch(request, env) {
    const app = createApp({ db: env.DB, adminKey: env.ADMIN_KEY || 'change-me-admin-key' });
    return app.handle(request);
  },
};
