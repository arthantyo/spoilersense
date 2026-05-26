import { Hono } from 'hono';
import type {
  OnAppInstallRequest,
  OnCommentCreateRequest,
  OnPostCreateRequest,
  TriggerResponse,
} from '@devvit/web/shared';
import { reddit, settings } from '@devvit/web/server';
import { isT1, isT3, isT5 } from '@devvit/shared-types/tid.js';
import {
  analyzeSpoilerRisk,
  formatSpoilerDecision,
  type SpoilerDecision,
} from '../core/spoiler';

export const triggers = new Hono();

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
    'Classifier output:',
    '```json',
    formatSpoilerDecision(props.decision),
    '```',
  ];

  return lines.join('\n');
};

const warnMessage = (decision: SpoilerDecision) =>
  [
    'Heads up: your content may include spoilers.',
    '',
    "Please mark spoiler-sensitive content clearly to avoid ruining other users' experience.",
    '',
    `Detected type: ${decision.spoiler_type}`,
    `Risk level: ${decision.risk_level}`,
  ].join('\n');

const shouldTreatAsSpoiler = (decision: SpoilerDecision) =>
  decision.spoiler_type !== 'none' || decision.risk_level !== 'LOW';

const maybeNotifyMods = async (props: {
  subredditId?: string;
  kind: 'post' | 'comment';
  authorName?: string;
  permalink?: string;
  decision: SpoilerDecision;
}) => {
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

  // Discord webhook is a string in the settings schema; coerce only from string.
  const rawDiscordWebhook = await settings.get('alertDiscordWebhookUrl');
  const discordWebhookUrl =
    typeof rawDiscordWebhook === 'string'
      ? rawDiscordWebhook.trim()
      : undefined;

  const alertBody = buildModAlertMarkdown(props);

  console.log(
    `[SpoilerSenser] alertMode rawObj: ${JSON.stringify(rawAlertMode)}`
  );
  console.log(
    `[SpoilerSenser] alertMode: ${String(alertMode)}, type: ${typeof alertMode}`
  );
  console.log(
    `[SpoilerSenser] shouldUseModmail: ${shouldUseModmail}, shouldUseDiscord: ${shouldUseDiscord}, discordWebhookUrl: ${String(discordWebhookUrl)}`
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
};

const isAppAuthored = async (authorName?: string): Promise<boolean> => {
  if (!authorName) {
    return false;
  }

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
    if (await isAppAuthored(post.authorName)) {
      return c.json<TriggerResponse>({ status: 'success' }, 200);
    }

    if (post.removed || post.spoiler) {
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
        await post.addComment({ text: warnMessage(decision) });
        break;
      case 'collapse':
        await post.filter(decision.reasoning, true);
        break;
      case 'send_to_modqueue':
        await post.filter(decision.reasoning, false);
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

  try {
    const comment = await reddit.getCommentById(commentId);
    if (await isAppAuthored(comment.authorName)) {
      return c.json<TriggerResponse>({ status: 'success' }, 200);
    }

    if (comment.removed) {
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
        await comment.reply({ text: warnMessage(decision) });
        break;
      case 'collapse':
        await comment.filter(decision.reasoning, true);
        break;
      case 'send_to_modqueue':
        await comment.filter(decision.reasoning, false);
        break;
      case 'remove':
        await comment.remove(false);
        break;
      case 'allow':
      default:
        break;
    }

    if (decision.risk_level !== 'LOW') {
      const post = await reddit.getPostById(comment.postId);
      if (!post.spoiler) {
        await post.markAsSpoiler();
      }
    }

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
