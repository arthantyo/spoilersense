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

export type AnalyzableContent = {
  kind: 'post' | 'comment';
  title?: string;
  body: string;
  subredditName?: string;
};

export const DEFAULT_DECISION: SpoilerDecision = {
  risk_level: 'LOW',
  spoiler_type: 'none',
  visibility_risk: 'low',
  recommended_action: 'allow',
  reasoning: 'No obvious spoiler content found.',
};
