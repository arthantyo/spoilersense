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
  const speculative = isSpeculativeLanguage(corpus);
  const confirmed = isConfirmedSpoilerLanguage(corpus);
  const deathRevealSignals = [
    'dies',
    'die',
    'death',
    'dead',
    'killed',
    'kill',
    'murdered',
    'assassinated',
    'slain',
  ];
  const hasDeathReveal = deathRevealSignals.some((term) =>
    corpus.includes(term)
  );
  const hardHits = bodySignals.hard.filter((word) =>
    corpus.includes(word)
  ).length;
  const mediumHits = bodySignals.medium.filter((word) =>
    corpus.includes(word)
  ).length;

  if (confirmed && hasDeathReveal) {
    return {
      risk_level: 'HIGH',
      spoiler_type: 'character_death',
      visibility_risk: 'high',
      recommended_action: 'remove',
      reasoning:
        'Confirmed first-hand death reveal detected, so the content was marked as an explicit spoiler for removal.',
    };
  }

  if (speculative && !confirmed && hardHits <= 1 && mediumHits <= 1) {
    return {
      ...DEFAULT_DECISION,
      reasoning:
        'Speculative or predictive language detected, so this was treated as a theory rather than a spoiler.',
    };
  }

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

const aggregateDecisions = (decisions: SpoilerDecision[]): SpoilerDecision => {
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

  // pick highest risk
  let bestRisk: RiskLevel = 'LOW';
  let bestVisibility: VisibilityRisk = 'low';
  let bestAction: RecommendedAction = 'allow';
  const typeCounts: Partial<Record<SpoilerType, number>> = {};
  const reasoningSet = new Set<string>();

  for (const d of decisions) {
    if (riskScore[d.risk_level] > riskScore[bestRisk]) bestRisk = d.risk_level;
    if (visibilityScore[d.visibility_risk] > visibilityScore[bestVisibility])
      bestVisibility = d.visibility_risk;
    if (actionScore[d.recommended_action] > actionScore[bestAction])
      bestAction = d.recommended_action;
    typeCounts[d.spoiler_type] = (typeCounts[d.spoiler_type] || 0) + 1;
    if (d.reasoning) reasoningSet.add(d.reasoning.trim());
  }

  // pick most frequent / most severe spoiler type
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

  const combinedReasoning = clampReasoning(
    Array.from(reasoningSet).join(' | ')
  );

  return {
    risk_level: bestRisk,
    spoiler_type: chosenType,
    visibility_risk: bestVisibility,
    recommended_action: bestAction,
    reasoning: combinedReasoning,
  };
};

const MAX_POST_TITLE_CHARS = 300;
const MAX_POST_BODY_CHARS = 40000;
const MAX_COMMENT_BODY_CHARS = 3000;
const MAX_LLM_EXCERPT_CHARS = 1800;
const MAX_LLM_CANDIDATES = 5;

const normalizeTitleForAnalysis = (title?: string): string | undefined => {
  if (!title) {
    return undefined;
  }

  return title.slice(0, MAX_POST_TITLE_CHARS);
};

const getBodyChunkSize = (contentKind: AnalyzableContent['kind']): number =>
  contentKind === 'post' ? MAX_POST_BODY_CHARS : MAX_COMMENT_BODY_CHARS;

const bodySignals = {
  hard: [
    'dies',
    'die',
    'death',
    'dead',
    'killed',
    'kill',
    'murder',
    'murdered',
    'assassinated',
    'slain',
    'shot',
    'stabbed',
    'beheaded',
    'executed',
    'ending',
    'finale',
    'season finale',
    'series finale',
    'final scene',
    'last scene',
    'post credit',
    'post-credits',
    'mid credits',
    'mid-credits',
    'plot twist',
    'twist ending',
    'the ending is',
    'it was all a dream',
    'final boss',
    'main villain',
    'true villain',
    'betrays',
    'betrayed',
    'traitor',
    'identity reveal',
    'secret identity',
    'identity is',
    'the killer is',
    'who dies',
    'who killed',
    'revealed to be',
    'is revealed',
  ],
  medium: [
    'spoiler',
    'spoilers',
    'spoiler warning',
    'episode',
    'episodes',
    'chapter',
    'chapters',
    'volume',
    'leak',
    'leaks',
    'leaked',
    'rumor',
    'rumour',
    'confirmed',
    'confirmation',
    'ending explained',
    'explained ending',
    'major reveal',
    'big reveal',
    'reveal',
    'after credits',
    'post credits scene',
    'post-credits scene',
    'credit scene',
    'scene after credits',
    'season ending',
    'series ending',
    'final episode',
    'series finale',
    'season finale',
    'cliffhanger',
    'identity',
    'killer',
    'dies in',
    'death scene',
  ],
} as const;

const speculationSignals = [
  'prediction',
  'predictions',
  'theory',
  'theories',
  'speculation',
  'speculative',
  'guess',
  'guessing',
  'might',
  'may',
  'could',
  'probably',
  'possibly',
  'seems like',
  'i think',
  'i bet',
  'my guess',
  'next season',
  'future season',
  'next episode',
  'eventually',
] as const;

const isSpeculativeLanguage = (corpus: string): boolean =>
  speculationSignals.some((term) => corpus.includes(term));

const confirmationSignals = [
  'i watched it',
  'i saw it',
  'i saw this',
  'i watched this',
  'confirmed',
  'actually dies',
  'actually dies in',
  'he dies',
  'she dies',
  'they die',
  'it happens',
  'this happens',
  'that happens',
  'in the episode',
  'in the movie',
  'in the finale',
  'spoiler',
  'spoilers',
  'leaked',
  'leak',
] as const;

const isConfirmedSpoilerLanguage = (corpus: string): boolean =>
  confirmationSignals.some((term) => corpus.includes(term));

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

  const quarters = [0, 0.25, 0.5, 0.75, 1]
    .map((fraction) => Math.floor(length * fraction))
    .filter(
      (center, index, centers) => index === 0 || center !== centers[index - 1]
    );

  return quarters;
};

const buildCandidateContents = (
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

const isSevereDecision = (decision: SpoilerDecision): boolean =>
  decision.risk_level === 'HIGH' || decision.recommended_action === 'remove';

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
            'You are a Reddit spoiler moderation classifier. Return JSON only, no markdown. Treat speculation, theories, and predictions as non-spoilers unless the text states confirmed plot details.',
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
              'If the text is framed as a theory, prediction, or guess, do not classify it as a spoiler unless it reveals confirmed details.',
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

  const title = normalizeTitleForAnalysis(content.title);
  const body = content.body ?? '';
  const analysisContent: AnalyzableContent = {
    kind: content.kind,
    body,
    ...(title ? { title } : {}),
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
      const llmDecision = await callLlm(singleCandidate, apiKey, model);
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
      const llmDecision = await callLlm(candidate, apiKey, model);
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

export const formatSpoilerDecision = (decision: SpoilerDecision): string =>
  JSON.stringify(decision, null, 2);
