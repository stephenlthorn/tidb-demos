import 'dd-trace/init';
import { createServer } from 'node:http';
import { createTidbPool } from '@lab/runner-kit';
import { SLOW_QUERY_SQL } from '../runner/src/slowQuery';

const pool = createTidbPool();

const server = createServer((request, response) => {
  if (request.url === '/slow-query') {
    void pool
      .query(SLOW_QUERY_SQL)
      .then(() => {
        response.writeHead(200).end('ok');
      })
      .catch(() => {
        response.writeHead(500).end('slow query failed');
      });
    return;
  }
  response.writeHead(404).end();
});

server.listen(Number(process.env.APM_SERVICE_PORT ?? 9096));
