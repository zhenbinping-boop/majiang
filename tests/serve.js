/**
 * tests/serve.js — 本地静态文件服务（测试用）：node tests/serve.js [port]
 * 根目录为仓库根（tests/ 的上一级），默认端口 8765。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = +(process.argv[2] || 8765);
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  const file = path.join(ROOT, urlPath);
  if (!file.startsWith(ROOT)) { res.statusCode = 403; res.end('forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.statusCode = 404; res.end('not found'); return; }
    res.setHeader('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => console.log('serving ' + ROOT + ' at http://127.0.0.1:' + PORT));
