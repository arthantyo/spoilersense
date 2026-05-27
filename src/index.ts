import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createServer, getServerPort } from '@devvit/web/server';
import { triggers } from './routes/triggers';

const app = new Hono();
const internal = new Hono();

// internal.route('/menu', api);

internal.route('/triggers', triggers);

app.route('/internal', internal);

serve({
  fetch: app.fetch,
  createServer,
  port: getServerPort(),
});
