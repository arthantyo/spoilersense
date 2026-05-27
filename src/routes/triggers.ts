import { Hono } from 'hono';
import type {
  OnAppInstallRequest,
  OnCommentCreateRequest,
  OnPostCreateRequest,
  TriggerResponse,
} from '@devvit/web/shared';
import { Post, reddit, settings } from '@devvit/web/server';
import { isT1, isT3, isT5 } from '@devvit/shared-types/tid.js';
import {
  analyzeSpoilerRisk,
  formatSpoilerDecision,
  type SpoilerDecision,
} from '../core/spoiler';

export const triggers = new Hono();

const appComment = async (text: string, post: Post) => {
  try {
    const modComment = await post.addComment({
      text,
    });
    await modComment.distinguish(true);
    await modComment.lock();
  } catch (err) {
    console.error('Failed to add or lock moderation comment:', err);
  }
};

const buildModAlertMarkdown = (props: {
  kind: 'post' | 'comment';
  authorName?: string;
  permalink?: string;
  decision: SpoilerDecision;
}) => {
  const lines = [
    `Detected potential spoiler in a new ${props.kind}.`,
    '',
    `Author: u/${props.authorName ?? 'unknown'}`,
    `Link: ${props.permalink ?? 'unknown'}`,
    '',
    'Moderation actions:',
    props.permalink
      ? `- Delete spoiler: open ${props.permalink} and remove the ${props.kind}.`
      : `- Delete spoiler: open the ${props.kind} in Reddit and remove it.`,
    '',
    'Classifier output:',
    '```json',
    formatSpoilerDecision(props.decision),
    '```',
  ];

  return lines.join('\n');
};

// No public user-facing warning comments: posts are flagged as spoiler and comments are collapsed.

const shouldTreatAsSpoiler = (decision: SpoilerDecision) =>
  decision.spoiler_type !== 'none' || decision.risk_level !== 'LOW';

const maybeNotifyMods = async (props: {
  subredditId?: string;
  kind: 'post' | 'comment';
  authorName?: string;
  permalink?: string;
  decision: SpoilerDecision;
}) => {
  // Skip alerts if the app already removed the content
  if (props.decision.recommended_action === 'remove') {
    console.log(
      `[SpoilerSenser] Skipping alert for ${props.kind} by u/${props.authorName}; content was removed by app.`
    );
    return;
  }

  const rawAlertMode = await settings.get('alertMode');
  // Coerce alertMode to a string. Devvit returns select values as arrays like ["both"].
  let alertMode: string;
  if (typeof rawAlertMode === 'string') {
    alertMode = rawAlertMode;
  } else if (Array.isArray(rawAlertMode) && rawAlertMode.length > 0) {
    alertMode = String(rawAlertMode[0]);
  } else if (
    rawAlertMode &&
    typeof rawAlertMode === 'object' &&
    !Array.isArray(rawAlertMode)
  ) {
    // fallback for other shapes
    const asAny = rawAlertMode as any;
    alertMode = (asAny.value ??
      asAny.selected ??
      asAny.label ??
      String(asAny)) as string;
  } else {
    alertMode = 'both';
  }

  const shouldUseModmail = alertMode === 'modmail' || alertMode === 'both';
  const shouldUseDiscord = alertMode === 'discord' || alertMode === 'both';
  const shouldUseSlack = alertMode === 'slack';

  // Discord webhook is a string in the settings schema; coerce only from string.
  const rawDiscordWebhook = await settings.get('alertDiscordWebhookUrl');
  const discordWebhookUrl =
    typeof rawDiscordWebhook === 'string'
      ? rawDiscordWebhook.trim()
      : undefined;
  const rawSlackWebhook = await settings.get('alertSlackWebhookUrl');
  const slackWebhookUrl =
    typeof rawSlackWebhook === 'string' ? rawSlackWebhook.trim() : undefined;

  const alertBody = buildModAlertMarkdown(props);

  console.log(
    `[SpoilerSenser] alertMode rawObj: ${JSON.stringify(rawAlertMode)}`
  );
  console.log(
    `[SpoilerSenser] alertMode: ${String(alertMode)}, type: ${typeof alertMode}`
  );
  console.log(
    `[SpoilerSenser] shouldUseModmail: ${shouldUseModmail}, shouldUseDiscord: ${shouldUseDiscord}, shouldUseSlack: ${shouldUseSlack}, discordWebhookUrl: ${String(discordWebhookUrl)}, slackWebhookUrl: ${String(slackWebhookUrl)}`
  );
  console.log(
    `[SpoilerSenser] subredditId: ${String(props.subredditId)}, isT5: ${Boolean(
      props.subredditId && isT5(props.subredditId)
    )}`
  );

  if (shouldUseModmail && props.subredditId && isT5(props.subredditId)) {
    try {
      console.log(
        `[SpoilerSenser] Sending modmail alert for subreddit ${props.subredditId}, ${props.kind} by u/${props.authorName}, risk: ${props.decision.risk_level}`
      );
      await reddit.modMail.createModNotification({
        subredditId: props.subredditId as any,
        subject: `SpoilerSenser: ${props.decision.risk_level} spoiler risk`,
        bodyMarkdown: alertBody,
      });
      console.log(
        `[SpoilerSenser] Modmail alert sent successfully for ${props.subredditId}`
      );
    } catch (err) {
      console.error(
        `[SpoilerSenser] Failed to send modmail for ${props.subredditId}:`,
        err
      );
    }
  }

  console.log(
    `[SpoilerSenser] Alert for ${props.kind} by u/${props.authorName}, risk: ${props.decision.risk_level}\n${alertBody}`
  );

  if (shouldUseDiscord && !discordWebhookUrl) {
    console.warn(
      'SpoilerSenser alertMode includes Discord, but alertDiscordWebhookUrl is not configured.'
    );
  }

  if (shouldUseSlack && !slackWebhookUrl) {
    console.warn(
      'SpoilerSenser alertMode includes Slack, but alertSlackWebhookUrl is not configured.'
    );
  }

  if (shouldUseDiscord && discordWebhookUrl) {
    await fetch(discordWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        username: 'SpoilerSenser',
        content: `SpoilerSenser alert (${props.decision.risk_level})`,
        embeds: [
          {
            title: `Potential spoiler in ${props.kind}`,
            description: alertBody,
            color:
              props.decision.risk_level === 'HIGH'
                ? 15158332
                : props.decision.risk_level === 'MEDIUM'
                  ? 16776960
                  : 5763719,
          },
        ],
      }),
    });
  }

  if (shouldUseSlack && slackWebhookUrl) {
    await fetch(slackWebhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: alertBody,
      }),
    });
  }
};

const isAppAuthored = async (
  authorName?: string,
  body?: string
): Promise<boolean> => {
  if (!authorName) {
    return false;
  }

  // Direct check: if the author is literally the app itself
  if (authorName.toLowerCase() === 'spoiler-sense') {
    return true;
  }

  // Also skip if body contains the app's warning message signature
  if (body && body.includes('Please mark spoiler-sensitive content clearly')) {
    return true;
  }

  // Fallback: check username directly
  const appUser = await reddit.getCurrentUser();
  if (!appUser) {
    return false;
  }

  return appUser.username.toLowerCase() === authorName.toLowerCase();
};

triggers.post('/on-app-install', async (c) => {
  const input = await c.req.json<OnAppInstallRequest>();
  console.log('App installed to subreddit: r/' + input.subreddit?.name);

  return c.json<TriggerResponse>(
    {
      status: 'success',
    },
    200
  );
});

triggers.post('/on-post-create', async (c) => {
  const input = await c.req.json<OnPostCreateRequest>();
  const postId = input.post?.id;
  if (!postId || !isT3(postId)) {
    return c.json<TriggerResponse>({ status: 'success' }, 200);
  }

  try {
    const post = await reddit.getPostById(postId);
    if (await isAppAuthored(post.authorName, post.body)) {
      return c.json<TriggerResponse>({ status: 'success' }, 200);
    }

    if (post.removed || post.spoiler) {
      return c.json<TriggerResponse>({ status: 'success' }, 200);
    }

    // Skip detection if post is already wrapped in spoiler tags >!...!<
    const postBodyTrimmed = (post.body || '').trim();
    if (/^>!.*!<$/s.test(postBodyTrimmed)) {
      return c.json<TriggerResponse>({ status: 'success' }, 200);
    }

    const decision = await analyzeSpoilerRisk({
      kind: 'post',
      title: post.title,
      body: post.body || '',
      subredditName: post.subredditName,
    });

    if (!shouldTreatAsSpoiler(decision)) {
      return c.json<TriggerResponse>({ status: 'success' }, 200);
    }

    if (!post.spoiler) {
      await post.markAsSpoiler();
    }

    switch (decision.recommended_action) {
      case 'warn_user':
        if (decision.risk_level === 'MEDIUM') {
          if (!post.spoiler) {
            await post.markAsSpoiler();
          }
        } else if (decision.risk_level === 'HIGH') {
          await post.filter(decision.reasoning, true);
        }

        appComment(
          `Hi u/${post.authorName}, our spoiler classifier has detected potential spoilers in your post. We've marked it as a spoiler just in case, but if you intended to include spoilers, please make sure to mark them clearly in the future. Thanks!`,
          post
        );
        break;
      case 'collapse':
        await post.filter(decision.reasoning, true);
        break;
      case 'send_to_modqueue':
        await post.filter(decision.reasoning, false);

        await appComment(
          `Hi u/${post.authorName}, our spoiler classifier has detected potential spoilers in your post. We've sent it to the mods for review. If you included spoilers, please make sure to mark them clearly in the future to avoid removal. Thanks!`,
          post
        );
        break;
      case 'remove':
        await post.remove(false);
        break;
      case 'allow':
      default:
        break;
    }

    await maybeNotifyMods({
      subredditId: post.subredditId,
      kind: 'post',
      authorName: post.authorName,
      permalink: post.permalink,
      decision,
    });
  } catch (error) {
    console.error('Spoiler handling failed for post create trigger.', error);
  }

  return c.json<TriggerResponse>({ status: 'success' }, 200);
});

triggers.post('/on-comment-create', async (c) => {
  const input = await c.req.json<OnCommentCreateRequest>();
  const commentId = input.comment?.id;
  if (!commentId || !isT1(commentId)) {
    return c.json<TriggerResponse>({ status: 'success' }, 200);
  }

  // skip if the comment is created in a post that is already marked as spoiler!
  const postId = input.post?.id;
  if (!postId || !isT3(postId)) {
    return c.json<TriggerResponse>({ status: 'success' }, 200);
  }

  const post = await reddit.getPostById(postId);
  if (post.spoiler) {
    return c.json<TriggerResponse>({ status: 'success' }, 200);
  }

  try {
    const comment = await reddit.getCommentById(commentId);
    if (await isAppAuthored(comment.authorName, comment.body)) {
      return c.json<TriggerResponse>({ status: 'success' }, 200);
    }

    if (comment.removed) {
      return c.json<TriggerResponse>({ status: 'success' }, 200);
    }

    // Skip detection if comment is already wrapped in spoiler tags >!...!<
    const commentBodyTrimmed = comment.body.trim();
    if (/^>!.*!<$/s.test(commentBodyTrimmed)) {
      return c.json<TriggerResponse>({ status: 'success' }, 200);
    }

    const decision = await analyzeSpoilerRisk({
      kind: 'comment',
      body: comment.body,
      subredditName: comment.subredditName,
    });

    if (!shouldTreatAsSpoiler(decision)) {
      return c.json<TriggerResponse>({ status: 'success' }, 200);
    }

    switch (decision.recommended_action) {
      case 'warn_user':
        if (decision.risk_level === 'MEDIUM') {
          await comment.filter(decision.reasoning, true);
        }
        break;
      case 'collapse':
        await comment.filter(decision.reasoning, true);
        break;
      case 'send_to_modqueue':
        await comment.filter(decision.reasoning, false);
        break;
      case 'remove':
        await comment.remove(false);
        await comment.addRemovalNote({
          modNote: `Removed by SpoilerSenser because of high spoiler risk.`,
          reasonId: '',
        });
        break;
      case 'allow':
      default:
        break;
    }

    // if (decision.risk_level !== 'LOW') {
    //   const post = await reddit.getPostById(comment.postId);
    //   if (!post.spoiler) {
    //     await post.markAsSpoiler();
    //   }
    // }

    await maybeNotifyMods({
      subredditId: comment.subredditId,
      kind: 'comment',
      authorName: comment.authorName,
      permalink: comment.permalink,
      decision,
    });
  } catch (error) {
    console.error('Spoiler handling failed for comment create trigger.', error);
  }

  return c.json<TriggerResponse>({ status: 'success' }, 200);
});
