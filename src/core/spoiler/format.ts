import type { SpoilerDecision } from './types';

export const formatSpoilerDecision = (decision: SpoilerDecision): string =>
  JSON.stringify(decision, null, 2);
