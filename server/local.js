'use strict';
// 本地开发服务器：同一端口提供 /api/* 与 public/ 静态文件
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./app.js');
const { createDb } = require('./db-shim.js');

const PORT = Number(process.env.PORT || 8787);
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const DB_FILE = process.env.DB_FILE || path.join(__dirname, '..', 'data.db');
const ADMIN_KEY = process.env.ADMIN_KEY || 'change-me-admin-key';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const db = createDb(DB_FILE);
const app = createApp({ db, adminKey: ADMIN_KEY });

async function toRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  return new Request(`http://localhost${req.url}`, {
    method: req.method,
    headers: req.headers,
    body: body.length ? body : undefined,
  });
}

function serveStatic(urlPath, res) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }
  const ext = path.extname(file);
  res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) {
    try {
      const request = await toRequest(req);
      const response = await app.handle(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(await response.text());
    } catch (e) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String((e && e.message) || e) }));
    }
    return;
  }
  serveStatic(url.pathname, res);
});

server.listen(PORT, () => {
  console.log(`月谕圣牌交换平台已启动: http://localhost:${PORT}  (ADMIN_KEY=${ADMIN_KEY})`);
});
