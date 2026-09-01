import { createServer } from 'node:http';
import next from 'next';
import { createPublicRuntime } from '../server/public/bootstrap';
import { configurePublicRuntime } from '../server/public/runtime';
import { runtimeConfig } from '../server/config/runtime-config';

const app = next({
  dev: false,
  hostname: '127.0.0.1',
  port: runtimeConfig.publicPort,
});

await app.prepare();
const runtime = await createPublicRuntime();
configurePublicRuntime(runtime);

const handle = app.getRequestHandler();
createServer((request, response) => {
  void handle(request, response);
}).listen(runtimeConfig.publicPort, '127.0.0.1', () => {
  console.log(`FlowPass public server listening on http://127.0.0.1:${runtimeConfig.publicPort}`);
});
