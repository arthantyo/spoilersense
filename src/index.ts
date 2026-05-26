import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { createServer, getServerPort } from '@devvit/web/server';
import { api, deleteSpoilerMenuHandler } from './routes/api';
import { triggers } from './routes/triggers';

const app = new Hono();
const internal = new Hono();

internal.route('/triggers', triggers);

app.route('/api', api);
app.route('/internal', internal);
app.post('/internal/menu/delete-spoiler', deleteSpoilerMenuHandler);

serve({
  fetch: app.fetch,
  createServer,
  port: getServerPort(),
});
