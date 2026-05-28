import type {
  OnAppInstallRequest,
  OnCommentCreateRequest,
  OnPostCreateRequest,
  TriggerResponse,
} from '@devvit/web/shared';
import { reddit } from '@devvit/web/server';
import { isT1, isT3 } from '@devvit/shared-types/tid.js';
import {
  appComment,
  isAppAuthored,
  maybeNotifyMods,
  shouldTreatAsSpoiler,
} from './helpers';
import { analyzeSpoilerRisk } from '../../core/spoiler/analysis';

const markPostAndNotify = async (
  post: Awaited<ReturnType<typeof reddit.getPostById>>
) => {
  if (!post.spoiler) {
    await post.markAsSpoiler();
  }
};

export const handleAppInstall = async (
  input: OnAppInstallRequest
): Promise<TriggerResponse> => {
  console.log('App installed to subreddit: r/' + input.subreddit?.name);

  return { status: 'success' };
};

export const handlePostCreate = async (
  input: OnPostCreateRequest
): Promise<TriggerResponse> => {
  const postId = input.post?.id;
  if (!postId || !isT3(postId)) {
    return { status: 'success' };
  }

  try {
    const post = await reddit.getPostById(postId);
    if (await isAppAuthored(post.authorName, post.body)) {
      return { status: 'success' };
    }

    if (post.removed || post.spoiler) {
      return { status: 'success' };
    }

    const postBodyTrimmed = (post.body || '').trim();
    if (/^>!.*!<$/s.test(postBodyTrimmed)) {
      return { status: 'success' };
    }

    const decision = await analyzeSpoilerRisk({
      kind: 'post',
      title: post.title,
      body: post.body || '',
      subredditName: post.subredditName,
    });

    if (!shouldTreatAsSpoiler(decision)) {
      return { status: 'success' };
    }

    await markPostAndNotify(post);

    switch (decision.recommended_action) {
      case 'warn_user':
        if (decision.risk_level === 'HIGH') {
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

  return { status: 'success' };
};

export const handleCommentCreate = async (
  input: OnCommentCreateRequest
): Promise<TriggerResponse> => {
  const commentId = input.comment?.id;
  if (!commentId || !isT1(commentId)) {
    return { status: 'success' };
  }

  const postId = input.post?.id;
  if (!postId || !isT3(postId)) {
    return { status: 'success' };
  }

  const post = await reddit.getPostById(postId);
  if (post.spoiler) {
    return { status: 'success' };
  }

  try {
    const comment = await reddit.getCommentById(commentId);
    if (await isAppAuthored(comment.authorName, comment.body)) {
      return { status: 'success' };
    }

    if (comment.removed) {
      return { status: 'success' };
    }

    const commentBodyTrimmed = comment.body.trim();
    if (/^>!.*!<$/s.test(commentBodyTrimmed)) {
      return { status: 'success' };
    }

    const decision = await analyzeSpoilerRisk({
      kind: 'comment',
      body: comment.body,
      subredditName: comment.subredditName,
    });

    if (!shouldTreatAsSpoiler(decision)) {
      return { status: 'success' };
    }

    switch (decision.recommended_action) {
      case 'warn_user':
        if (decision.risk_level === 'MEDIUM') {
          await comment.filter(decision.reasoning, true);
        }

        const modComment = await comment.reply({
          text: `Hi u/${post.authorName}, our spoiler classifier has detected potential spoilers in your comment. Please make sure to mark them clearly in the future to avoid removal. Thanks!`,
        });

        modComment.distinguish(true);
        modComment.lock();
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

  return { status: 'success' };
};
