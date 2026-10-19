// ==================================================================================
// CHANDRAMAULI MUSTARD OIL ERP - LOCALHOST SERVER (Node.js)
// Hosts BOTH the Flutter Web ERP and the Backend API at http://localhost:5000
// ==================================================================================

require('dotenv').config();
const http = require('http');
const path = require('path');
const fs = require('fs');
const { handler } = require('./netlify/functions/api');

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.woff': 'application/font-woff',
  '.woff2': 'font/woff2',
  '.ttf': 'application/font-ttf',
  '.eot': 'application/vnd.ms-fontobject',
  '.otf': 'application/font-otf',
  '.wasm': 'application/wasm',
};

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // Handle CORS Preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, X-App-Package, X-App-Signature-SHA1, X-App-Signature-SHA256, X-App-Timestamp',
    });
    res.end();
    return;
  }

  // 1. API ROUTES: /api/* or /health or /.netlify/*
  if (pathname.startsWith('/api') || pathname.startsWith('/.netlify') || pathname === '/health') {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      try {
        const queryParams = {};
        parsedUrl.searchParams.forEach((val, key) => {
          queryParams[key] = val;
        });

        const event = {
          path: pathname,
          httpMethod: req.method,
          headers: req.headers,
          queryStringParameters: queryParams,
          body: rawBody || null,
        };

        const result = await handler(event, {});

        const headers = {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, X-App-Package, X-App-Signature-SHA1, X-App-Signature-SHA256, X-App-Timestamp',
          ...(result.headers || {}),
        };

        res.writeHead(result.statusCode || 200, headers);
        res.end(result.body || '');
      } catch (err) {
        console.error('[API Error]', err);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal Server Error', message: err.message }));
      }
    });
    return;
  }

  // 2. DIAGNOSTIC PAGE: /diagnostics
  if (pathname === '/diagnostics') {
    const hasSupabase = !!(process.env.SUPABASE_URL && (process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY));
    const hasSha = !!(process.env.APP_SHA1 || process.env.APP_SHA256);

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"><title>Chandramauli ERP - Localhost</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #0f172a; color: #f8fafc; padding: 24px; }
    .box { max-width: 700px; margin: 0 auto; background: #1e293b; padding: 24px; border-radius: 8px; }
    h1 { color: #f59e0b; margin-top: 0; }
    a { color: #38bdf8; }
    code { background: #334155; padding: 2px 6px; border-radius: 4px; }
  </style>
</head>
<body>
  <div class="box">
    <h1>🌾 Chandramauli Oil ERP Diagnostics</h1>
    <p>✅ Server: Running on http://localhost:${PORT}</p>
    <p>Supabase: ${hasSupabase ? '<span style="color:#4ade80;">Connected</span>' : '<span style="color:#f87171;">Not configured</span>'}</p>
    <p>SHA Verification: ${hasSha ? 'Active' : 'Open (development mode)'}</p>
    <p><a href="/">👈 Return to Web App</a> | <a href="/api/health">Check API Health</a></p>
  </div>
</body>
</html>
    `);
    return;
  }

  // 3. STATIC FILES & FLUTTER WEB APP
  if (fs.existsSync(PUBLIC_DIR)) {
    let relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
    let filePath = path.join(PUBLIC_DIR, relativePath);

    // If requested file does not exist, fallback to index.html for Flutter web routing
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    if (fs.existsSync(filePath)) {
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';

      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000',
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found', path: pathname }));
});

server.listen(PORT, HOST, () => {
  console.log(`=============================================================`);
  console.log(`🌾 Chandramauli Oil ERP - Localhost Full-Stack Server Ready!`);
  console.log(`💻 Web Application: http://localhost:${PORT}`);
  console.log(`📡 Backend API:     http://localhost:${PORT}/api/health`);
  console.log(`📱 Local Network:   http://${HOST}:${PORT}`);
  console.log(`=============================================================`);
});
