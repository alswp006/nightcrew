// fac_demo 픽스처 서버 — Q1(실제 fac_* 앱) 확정 전까지 §13 수동 검증용.
// 사용: node qa-sentinel/apps/fac_demo/fixtures/server.mjs  (기본 포트 4173, PORT env로 변경)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const dir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 4173);

http
  .createServer(async (req, res) => {
    try {
      const html = await readFile(path.join(dir, 'index.html'), 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  })
  .listen(port, '127.0.0.1', () => {
    console.log(`[fac_demo] fixture server on http://127.0.0.1:${port}`);
  });
