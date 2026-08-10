import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import {
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path';

const root = resolve('reports/latest');
const port = Number(process.env['PORT'] ?? 4173);
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'application/x-ndjson; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

const server = createServer(async (request, response) => {
  const rawPath = new URL(
    request.url ?? '/',
    `http://${request.headers.host ?? 'localhost'}`
  ).pathname;
  const relativePath =
    rawPath === '/' ? 'index.html' : normalize(rawPath).replace(/^[/\\]+/u, '');
  const filePath = resolve(join(root, relativePath));
  const pathFromRoot = relative(root, filePath);

  if (
    isAbsolute(pathFromRoot) ||
    pathFromRoot === '..' ||
    pathFromRoot.startsWith(`..${sep}`)
  ) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const file = await stat(filePath);
    if (!file.isFile()) throw new Error('Not a file');
    response.writeHead(200, {
      'Content-Type':
        contentTypes[extname(filePath)] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response
      .writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      .end('Not found');
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Serving reports at http://127.0.0.1:${port}`);
});
