import { settings } from '@devvit/web/server';
import { callLlm } from '../llmProvider';
import { buildCandidateContents } from './candidates';
import { coerceDecision, parseJsonObject, aggregateDecisions } from './decision';
import { getHeuristicDecision } from './heuristics';
import { MAX_LLM_EXCERPT_CHARS } from './constants';
import {
  type AnalyzableContent,
  type RecommendedAction,
  type SpoilerDecision,
} from './types';

const isSevereDecision = (decision: SpoilerDecision): boolean =>
  decision.risk_level === 'HIGH' || decision.recommended_action === 'remove';

const getNormalizedAction = (
  decision: SpoilerDecision,
  contentKind: 'post' | 'comment'
): RecommendedAction => {
  if (decision.recommended_action !== 'allow') {
    return decision.recommended_action;
  }

  if (decision.risk_level === 'HIGH') {
    return 'send_to_modqueue';
  }

  if (decision.risk_level === 'MEDIUM') {
    return contentKind === 'post' ? 'warn_user' : 'collapse';
  }

  return 'allow';
};

export const analyzeSpoilerRisk = async (
  content: AnalyzableContent
): Promise<SpoilerDecision> => {
  const apiKey = (await settings.get<string>('spoilerLlmApiKey'))?.trim();
  const model =
    (await settings.get<string[]>('spoilerLlmModel'))?.[0] || 'gpt-4o-mini';

  const body = content.body ?? '';
  const analysisContent: AnalyzableContent = {
    kind: content.kind,
    body,
    ...(content.title ? { title: content.title } : {}),
    ...(content.subredditName ? { subredditName: content.subredditName } : {}),
  };

  const byHeuristic = getHeuristicDecision(analysisContent);
  const candidates = buildCandidateContents(analysisContent);

  if (!apiKey) {
    return {
      ...byHeuristic,
      recommended_action: getNormalizedAction(byHeuristic, content.kind),
      reasoning: `${byHeuristic.reasoning} (No LLM key configured, fallback mode.)`,
    };
  }

  if (byHeuristic.risk_level === 'HIGH') {
    return {
      ...byHeuristic,
      recommended_action: getNormalizedAction(byHeuristic, content.kind),
    };
  }

  const singleCandidate = candidates[0];
  if (
    candidates.length === 1 &&
    singleCandidate &&
    singleCandidate.body.length <= MAX_LLM_EXCERPT_CHARS
  ) {
    try {
      const raw = await callLlm(singleCandidate, apiKey, model);
      const llmDecision = coerceDecision(parseJsonObject(raw));
      return {
        ...llmDecision,
        recommended_action: getNormalizedAction(llmDecision, content.kind),
      };
    } catch (error) {
      console.error('Spoiler LLM failed, using heuristic classifier.', error);
      return {
        ...byHeuristic,
        recommended_action: getNormalizedAction(byHeuristic, content.kind),
        reasoning: `${byHeuristic.reasoning} (LLM unavailable, fallback mode.)`,
      };
    }
  }

  const decisions: SpoilerDecision[] = [];
  for (const candidate of candidates) {
    const heuristic = getHeuristicDecision(candidate);
    if (isSevereDecision(heuristic)) {
      return {
        ...heuristic,
        recommended_action: getNormalizedAction(heuristic, content.kind),
      };
    }

    if (
      heuristic.risk_level === 'LOW' &&
      candidate.body.length > MAX_LLM_EXCERPT_CHARS
    ) {
      decisions.push({
        ...heuristic,
        recommended_action: getNormalizedAction(heuristic, content.kind),
      });
      continue;
    }

    try {
      const raw = await callLlm(candidate, apiKey, model);
      const llmDecision = coerceDecision(parseJsonObject(raw));
      const normalizedDecision = {
        ...llmDecision,
        recommended_action: getNormalizedAction(llmDecision, content.kind),
      };

      decisions.push(normalizedDecision);

      if (isSevereDecision(normalizedDecision)) {
        return normalizedDecision;
      }
    } catch (error) {
      console.error('Spoiler LLM failed, using heuristic classifier.', error);
      decisions.push({
        ...heuristic,
        recommended_action: getNormalizedAction(heuristic, content.kind),
        reasoning: `${heuristic.reasoning} (LLM unavailable, fallback mode.)`,
      });
    }
  }

  const aggregated = aggregateDecisions([byHeuristic, ...decisions]);
  return {
    ...aggregated,
    recommended_action: getNormalizedAction(aggregated, content.kind),
  };
};
