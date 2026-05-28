import {
  DEFAULT_DECISION,
  type RecommendedAction,
  type RiskLevel,
  type SpoilerDecision,
  type SpoilerType,
  type VisibilityRisk,
} from './types';

const riskLevelValues = new Set<RiskLevel>(['LOW', 'MEDIUM', 'HIGH']);
const spoilerTypeValues = new Set<SpoilerType>([
  'none',
  'hint',
  'episode_spoiler',
  'character_death',
  'major_plot',
]);
const visibilityRiskValues = new Set<VisibilityRisk>(['low', 'medium', 'high']);
const actionValues = new Set<RecommendedAction>([
  'allow',
  'warn_user',
  'collapse',
  'send_to_modqueue',
  'remove',
]);

export const clampReasoning = (value: unknown): string => {
  if (typeof value !== 'string') {
    return DEFAULT_DECISION.reasoning;
  }

  return value.trim().slice(0, 240) || DEFAULT_DECISION.reasoning;
};

export const parseJsonObject = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      const candidate = raw.slice(firstBrace, lastBrace + 1);
      return JSON.parse(candidate);
    }
    throw new Error('No valid JSON object found in model response.');
  }
};

export const coerceDecision = (value: unknown): SpoilerDecision => {
  if (!value || typeof value !== 'object') {
    return DEFAULT_DECISION;
  }

  const data = value as Partial<Record<keyof SpoilerDecision, unknown>>;
  const risk_level = riskLevelValues.has(data.risk_level as RiskLevel)
    ? (data.risk_level as RiskLevel)
    : DEFAULT_DECISION.risk_level;
  const spoiler_type = spoilerTypeValues.has(data.spoiler_type as SpoilerType)
    ? (data.spoiler_type as SpoilerType)
    : DEFAULT_DECISION.spoiler_type;
  const visibility_risk = visibilityRiskValues.has(
    data.visibility_risk as VisibilityRisk
  )
    ? (data.visibility_risk as VisibilityRisk)
    : DEFAULT_DECISION.visibility_risk;
  const recommended_action = actionValues.has(
    data.recommended_action as RecommendedAction
  )
    ? (data.recommended_action as RecommendedAction)
    : DEFAULT_DECISION.recommended_action;

  return {
    risk_level,
    spoiler_type,
    visibility_risk,
    recommended_action,
    reasoning: clampReasoning(data.reasoning),
  };
};

export const aggregateDecisions = (
  decisions: SpoilerDecision[]
): SpoilerDecision => {
  if (!decisions || decisions.length === 0) return DEFAULT_DECISION;

  const riskScore: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };
  const visibilityScore: Record<VisibilityRisk, number> = {
    low: 0,
    medium: 1,
    high: 2,
  };
  const actionScore: Record<RecommendedAction, number> = {
    allow: 0,
    warn_user: 1,
    collapse: 2,
    send_to_modqueue: 3,
    remove: 4,
  };

  let bestRisk: RiskLevel = 'LOW';
  let bestVisibility: VisibilityRisk = 'low';
  let bestAction: RecommendedAction = 'allow';
  const typeCounts: Partial<Record<SpoilerType, number>> = {};
  const reasoningSet = new Set<string>();

  for (const d of decisions) {
    if (riskScore[d.risk_level] > riskScore[bestRisk]) bestRisk = d.risk_level;
    if (visibilityScore[d.visibility_risk] > visibilityScore[bestVisibility]) {
      bestVisibility = d.visibility_risk;
    }
    if (actionScore[d.recommended_action] > actionScore[bestAction]) {
      bestAction = d.recommended_action;
    }
    typeCounts[d.spoiler_type] = (typeCounts[d.spoiler_type] || 0) + 1;
    if (d.reasoning) reasoningSet.add(d.reasoning.trim());
  }

  const typePriority: SpoilerType[] = [
    'character_death',
    'major_plot',
    'episode_spoiler',
    'hint',
    'none',
  ];
  let chosenType: SpoilerType = 'none';
  for (const t of typePriority) {
    if (typeCounts[t]) {
      chosenType = t;
      break;
    }
  }

  return {
    risk_level: bestRisk,
    spoiler_type: chosenType,
    visibility_risk: bestVisibility,
    recommended_action: bestAction,
    reasoning: clampReasoning(Array.from(reasoningSet).join(' | ')),
  };
};
