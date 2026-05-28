import { isT5 } from '@devvit/shared-types/tid.js';
import { Post, reddit, settings } from '@devvit/web/server';
import { SpoilerDecision } from '../../core/spoiler/types';
import { formatSpoilerDecision } from '../../core/spoiler/format';

export const appComment = async (text: string, post: Post) => {
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

const normalizeAlertMode = async (): Promise<string> => {
  const rawAlertMode = await settings.get('alertMode');

  if (typeof rawAlertMode === 'string') {
    return rawAlertMode;
  }

  if (Array.isArray(rawAlertMode) && rawAlertMode.length > 0) {
    return String(rawAlertMode[0]);
  }

  if (
    rawAlertMode &&
    typeof rawAlertMode === 'object' &&
    !Array.isArray(rawAlertMode)
  ) {
    const asAny = rawAlertMode as any;
    return String(
      asAny.value ?? asAny.selected ?? asAny.label ?? String(asAny)
    );
  }

  return 'both';
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

export const shouldTreatAsSpoiler = (decision: SpoilerDecision) =>
  decision.spoiler_type !== 'none' || decision.risk_level !== 'LOW';

export const maybeNotifyMods = async (props: {
  subredditId?: string;
  kind: 'post' | 'comment';
  authorName?: string;
  permalink?: string;
  decision: SpoilerDecision;
}) => {
  if (props.decision.recommended_action === 'remove') {
    console.log(
      `[SpoilerSenser] Skipping alert for ${props.kind} by u/${props.authorName}; content was removed by app.`
    );
    return;
  }

  const alertMode = await normalizeAlertMode();
  const shouldUseModmail = alertMode === 'modmail' || alertMode === 'both';
  const shouldUseDiscord = alertMode === 'discord' || alertMode === 'both';
  const shouldUseSlack = alertMode === 'slack';

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
    `[SpoilerSenser] alertMode: ${String(alertMode)}, shouldUseModmail: ${shouldUseModmail}, shouldUseDiscord: ${shouldUseDiscord}, shouldUseSlack: ${shouldUseSlack}`
  );

  if (shouldUseModmail && props.subredditId && isT5(props.subredditId)) {
    try {
      await reddit.modMail.createModNotification({
        subredditId: props.subredditId as any,
        subject: `SpoilerSenser: ${props.decision.risk_level} spoiler risk`,
        bodyMarkdown: alertBody,
      });
    } catch (err) {
      console.error(
        `[SpoilerSenser] Failed to send modmail for ${props.subredditId}:`,
        err
      );
    }
  }

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

export const isAppAuthored = async (
  authorName?: string,
  body?: string
): Promise<boolean> => {
  if (!authorName) {
    return false;
  }

  if (authorName.toLowerCase() === 'spoiler-sense') {
    return true;
  }

  if (body && body.includes('Please mark spoiler-sensitive content clearly')) {
    return true;
  }

  const appUser = await reddit.getCurrentUser();
  if (!appUser) {
    return false;
  }

  return appUser.username.toLowerCase() === authorName.toLowerCase();
};
