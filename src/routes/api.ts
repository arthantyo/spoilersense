import { Hono, type Context } from 'hono';
import type { MenuItemRequest, UiResponse } from '@devvit/web/shared';
import { reddit } from '@devvit/web/server';
import { isT1 } from '@devvit/shared-types/tid.js';

export const api = new Hono();

export const deleteSpoilerMenuHandler = async (c: Context) => {
  const input = await c.req.json<MenuItemRequest>();

  try {
    if (input.location === 'comment' && isT1(input.targetId)) {
      const comment = await reddit.getCommentById(input.targetId);
      await comment.remove(false);

      return c.json<UiResponse>({
        showToast: {
          text: 'Spoiler comment deleted.',
          appearance: 'success',
        },
      });
    }

    return c.json<UiResponse>({
      showToast: {
        text: 'Delete spoiler is only available for comments.',
      },
    });
  } catch (error) {
    console.error(
      '[SpoilerSenser] Failed to delete spoiler from menu action.',
      error
    );

    return c.json<UiResponse>({
      showToast: {
        text: 'Failed to delete spoiler. Please try again.',
      },
    });
  }
};

api.post('/delete-spoiler', deleteSpoilerMenuHandler);
