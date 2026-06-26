import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = normalize(fileURLToPath(new URL('../dist', import.meta.url)));
const port = Number(process.env.PORT || 4173);
const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml']
]);

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
  const requested = normalize(join(root, decodeURIComponent(url.pathname)));
  const file = requested.startsWith(root) && existsSync(requested) && statSync(requested).isFile() ? requested : join(root, 'index.html');
  response.writeHead(200, { 'Content-Type': types.get(extname(file)) ?? 'application/octet-stream' });
  createReadStream(file)
    .on('error', () => {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    })
    .pipe(response);
});

server.on('error', (error) => {
  try {
    console.error(error);
  } finally {
    process.exitCode = 1;
  }
});

server.listen(port, '127.0.0.1');
