import { bodySignals, confirmationSignals, speculationSignals } from './constants';
import { DEFAULT_DECISION, type AnalyzableContent, type SpoilerDecision } from './types';

const isSpeculativeLanguage = (corpus: string): boolean =>
  speculationSignals.some((term) => corpus.includes(term));

const isConfirmedSpoilerLanguage = (corpus: string): boolean =>
  confirmationSignals.some((term) => corpus.includes(term));

export const getHeuristicDecision = (
  content: AnalyzableContent
): SpoilerDecision => {
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
  const hardHits = bodySignals.hard.filter((word) => corpus.includes(word))
    .length;
  const mediumHits = bodySignals.medium.filter((word) => corpus.includes(word))
    .length;

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
