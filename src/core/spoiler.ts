import { settings } from '@devvit/web/server';

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type SpoilerType =
  | 'none'
  | 'hint'
  | 'episode_spoiler'
  | 'character_death'
  | 'major_plot';
export type VisibilityRisk = 'low' | 'medium' | 'high';
export type RecommendedAction =
  | 'allow'
  | 'warn_user'
  | 'collapse'
  | 'send_to_modqueue'
  | 'remove';

export type SpoilerDecision = {
  risk_level: RiskLevel;
  spoiler_type: SpoilerType;
  visibility_risk: VisibilityRisk;
  recommended_action: RecommendedAction;
  reasoning: string;
};

type AnalyzableContent = {
  kind: 'post' | 'comment';
  title?: string;
  body: string;
  subredditName?: string;
};

const DEFAULT_DECISION: SpoilerDecision = {
  risk_level: 'LOW',
  spoiler_type: 'none',
  visibility_risk: 'low',
  recommended_action: 'allow',
  reasoning: 'No obvious spoiler content found.',
};

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

const clampReasoning = (value: unknown): string => {
  if (typeof value !== 'string') {
    return DEFAULT_DECISION.reasoning;
  }

  return value.trim().slice(0, 240) || DEFAULT_DECISION.reasoning;
};

const parseJsonObject = (raw: string): unknown => {
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

const coerceDecision = (value: unknown): SpoilerDecision => {
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

const getHeuristicDecision = (content: AnalyzableContent): SpoilerDecision => {
  const corpus = `${content.title ?? ''}\n${content.body}`.toLowerCase();
  const hardSignals = [
    'dies',
    'death',
    'killed',
    'ending',
    'final scene',
    'post credit',
    'plot twist',
    'final boss',
    'betrays',
    'identity reveal',
  ];
  const mediumSignals = [
    'spoiler',
    'episode',
    'chapter',
    'leak',
    'ending explained',
    'major reveal',
    'after credits',
  ];

  const hardHits = hardSignals.filter((word) => corpus.includes(word)).length;
  const mediumHits = mediumSignals.filter((word) =>
    corpus.includes(word)
  ).length;

  if (hardHits >= 2) {
    const deathSignals = ['dies', 'death', 'killed'];
    return {
      risk_level: 'HIGH',
      spoiler_type: deathSignals.some((word) => corpus.includes(word))
        ? 'character_death'
        : 'major_plot',
      visibility_risk: 'high',
      recommended_action: 'send_to_modqueue',
      reasoning:
        'Multiple high-confidence spoiler terms detected by local fallback classifier.',
    };
  }

  if (hardHits === 1 || mediumHits >= 2) {
    return {
      risk_level: 'MEDIUM',
      spoiler_type: mediumHits > 0 ? 'episode_spoiler' : 'hint',
      visibility_risk: 'medium',
      recommended_action: 'warn_user',
      reasoning:
        'Potential spoiler language detected by local fallback classifier.',
    };
  }

  return DEFAULT_DECISION;
};

const callLlm = async (
  content: AnalyzableContent,
  apiKey: string,
  model: string
): Promise<SpoilerDecision> => {
  const schema = {
    risk_level: 'LOW | MEDIUM | HIGH',
    spoiler_type:
      'none | hint | episode_spoiler | character_death | major_plot',
    visibility_risk: 'low | medium | high',
    recommended_action:
      'allow | warn_user | collapse | send_to_modqueue | remove',
    reasoning: 'short explanation',
  };

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        {
          role: 'system',
          content:
            'You are a Reddit spoiler moderation classifier. Return JSON only, no markdown.',
        },
        {
          role: 'user',
          content: JSON.stringify({
            task: 'Classify spoiler risk for this Reddit content.',
            schema,
            content: {
              kind: content.kind,
              subredditName: content.subredditName,
              title: content.title,
              body: content.body,
            },
            policy: [
              'If uncertain, choose the safer of two neighboring levels.',
              'Use remove only for severe explicit spoilers or repeated direct reveal style text.',
              'Use send_to_modqueue for medium/high visibility risk spoilers.',
            ],
          }),
        },
      ],
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    throw new Error(`LLM request failed with status ${response.status}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const raw = payload.choices?.[0]?.message?.content ?? '';

  if (!raw.trim()) {
    throw new Error('LLM response did not contain output content.');
  }

  return coerceDecision(parseJsonObject(raw));
};

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
    (await settings.get<string>('spoilerLlmModel'))?.trim() || 'gpt-4o-mini';

  const byHeuristic = getHeuristicDecision(content);
  if (!apiKey) {
    return {
      ...byHeuristic,
      recommended_action: getNormalizedAction(byHeuristic, content.kind),
      reasoning: `${byHeuristic.reasoning} (No LLM key configured, fallback mode.)`,
    };
  }

  try {
    const llmDecision = await callLlm(content, apiKey, model);
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
};

export const formatSpoilerDecision = (decision: SpoilerDecision): string =>
  JSON.stringify(decision, null, 2);
