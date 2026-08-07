'use strict';
// 简易压测脚本（无第三方依赖）：用法
//   node scripts/load-test.js --url https://你的worker域名 --total 500 --concurrency 20
//   node scripts/load-test.js --url http://localhost:8787 --path /api/stats --total 200
const path = require('node:path');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const base = String(arg('url', 'http://localhost:8787')).replace(/\/+$/, '');
const total = Number(arg('total', 300));
const concurrency = Number(arg('concurrency', 15));
const urlPath = String(arg('path', '/api/posts'));

async function main() {
  const url = base + urlPath;
  const latencies = [];
  let errors = 0;
  let next = 0;
  const started = Date.now();

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= total) return;
      const t0 = Date.now();
      try {
        const res = await fetch(url);
        await res.arrayBuffer();
        if (!res.ok) errors++;
      } catch {
        errors++;
      }
      latencies.push(Date.now() - t0);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const elapsed = (Date.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))];

  console.log(`目标: ${url}`);
  console.log(`总量: ${total} 并发: ${concurrency} 耗时: ${elapsed.toFixed(2)}s`);
  console.log(`吞吐: ${Math.round(total / elapsed)} req/s`);
  console.log(`错误: ${errors}`);
  console.log(`延迟: p50=${pct(0.5)}ms p95=${pct(0.95)}ms p99=${pct(0.99)}ms max=${latencies[latencies.length - 1]}ms`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
