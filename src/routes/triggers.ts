import { Hono } from 'hono';
import type {
  OnAppInstallRequest,
  OnCommentCreateRequest,
  OnPostCreateRequest,
  TriggerResponse,
} from '@devvit/web/shared';
import {
  handleAppInstall,
  handleCommentCreate,
  handlePostCreate,
} from './triggers/handlers';

export const triggers = new Hono();

triggers.post('/on-app-install', async (c) => {
  const input = await c.req.json<OnAppInstallRequest>();
  return c.json<TriggerResponse>(await handleAppInstall(input), 200);
});

triggers.post('/on-post-create', async (c) => {
  const input = await c.req.json<OnPostCreateRequest>();
  return c.json<TriggerResponse>(await handlePostCreate(input), 200);
});

triggers.post('/on-comment-create', async (c) => {
  const input = await c.req.json<OnCommentCreateRequest>();
  return c.json<TriggerResponse>(await handleCommentCreate(input), 200);
});
