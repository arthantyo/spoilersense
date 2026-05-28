import {
  MAX_COMMENT_BODY_CHARS,
  MAX_LLM_CANDIDATES,
  MAX_LLM_EXCERPT_CHARS,
  MAX_POST_BODY_CHARS,
  MAX_POST_TITLE_CHARS,
  bodySignals,
} from './constants';
import type { AnalyzableContent } from './types';

export const normalizeTitleForAnalysis = (
  title?: string
): string | undefined => {
  if (!title) {
    return undefined;
  }

  return title.slice(0, MAX_POST_TITLE_CHARS);
};

const getBodyChunkSize = (contentKind: AnalyzableContent['kind']): number =>
  contentKind === 'post' ? MAX_POST_BODY_CHARS : MAX_COMMENT_BODY_CHARS;

const extractSignalHits = (
  text: string
): Array<{ index: number; term: string }> => {
  const lowerText = text.toLowerCase();
  const hits: Array<{ index: number; term: string }> = [];

  for (const term of [...bodySignals.hard, ...bodySignals.medium]) {
    let index = lowerText.indexOf(term);
    while (index >= 0) {
      hits.push({ index, term });
      index = lowerText.indexOf(term, index + term.length);
    }
  }

  return hits.sort(
    (left, right) =>
      left.index - right.index || left.term.length - right.term.length
  );
};

const buildExcerpt = (text: string, center: number, length: number): string => {
  if (text.length <= length) {
    return text;
  }

  const half = Math.floor(length / 2);
  const start = Math.max(0, Math.min(center - half, text.length - length));
  return text.slice(start, start + length);
};

const buildSampleCenters = (length: number): number[] => {
  if (length <= MAX_LLM_EXCERPT_CHARS) {
    return [Math.floor(length / 2)];
  }

  return [0, 0.25, 0.5, 0.75, 1]
    .map((fraction) => Math.floor(length * fraction))
    .filter((center, index, centers) => index === 0 || center !== centers[index - 1]);
};

export const buildCandidateContents = (
  content: AnalyzableContent
): AnalyzableContent[] => {
  const body = content.body.slice(0, getBodyChunkSize(content.kind));
  const title = normalizeTitleForAnalysis(content.title);
  const baseContent: AnalyzableContent = {
    kind: content.kind,
    body,
    ...(title ? { title } : {}),
    ...(content.subredditName ? { subredditName: content.subredditName } : {}),
  };

  if (body.length <= MAX_LLM_EXCERPT_CHARS) {
    return [baseContent];
  }

  const candidates: AnalyzableContent[] = [];
  const signalHits = extractSignalHits(body);
  const centers = new Set<number>(buildSampleCenters(body.length));

  for (const hit of signalHits.slice(0, MAX_LLM_CANDIDATES)) {
    centers.add(hit.index + Math.floor(hit.term.length / 2));
  }

  for (const center of centers) {
    const excerpt = buildExcerpt(body, center, MAX_LLM_EXCERPT_CHARS);
    candidates.push({
      ...baseContent,
      body: excerpt,
    });

    if (candidates.length >= MAX_LLM_CANDIDATES) {
      break;
    }
  }

  return candidates.length > 0 ? candidates : [baseContent];
};
