# Spoiler Senser

> This was a submission to the Reddit Mod Tools and Migrated Apps Hackathon

Spoiler Senser is a Devvit moderation app that detects likely spoilers of Anime, TV Shows, Books in new posts and comments.

## What it does

- Classifies every new post/comment with an LLM (with local heuristic fallback).
- Produces this normalized decision shape:

```json
{
  "risk_level": "LOW | MEDIUM | HIGH",
  "spoiler_type": "none | hint | episode_spoiler | character_death | major_plot",
  "visibility_risk": "low | medium | high",
  "recommended_action": "allow | warn_user | collapse | send_to_modqueue | remove",
  "reasoning": "short explanation"
}
```

- Marks risky posts as spoiler.
- Warns users by replying to suspicious content.
- Sends risky content to mod queue using filter actions.
- Alerts moderators via Modmail, Discord webhook, or Slack incoming webhook with the classifier JSON.

## Setup

1. Install the app in your subreddit.
2. Open app settings and set:
   - Subreddit settings:

- `spoilerLlmApiKey` (per-subreddit OpenAI API key)
- `spoilerLlmModel` (default: `gpt-4o-mini`)
  - `alertMode` (`modmail` | `discord` | `slack` | `both`, default: `both`)
  - `alertDiscordWebhookUrl` (per-subreddit webhook; required for Discord modes)
  - `alertSlackWebhookUrl` (per-subreddit webhook; required for Slack mode)

If no API key is configured, Spoiler Senser still runs in fallback heuristic mode (not effective).

# Heuristics

- Primary approach: Heuristic-first; only call the LLM on short excerpts when heuristics are uncertain or hits appear.
- Quick scan: A cheap full-body heuristic scan looks for strong signals (death/reveals) and weaker signals (ending/twist/lists).
- Signal categories: Hard signals (explicit reveal words like "dies", "killed", "confirmed dead", character names + "was killed") and Medium signals (ending, finale, twist, major reveal, plot summary).
- Speculation handling: If language is speculative (predictions, "might", "probably", "I think") and no confirmation signals present, the heuristic downgrades to LOW risk to avoid false positives.
- Confirmation detection: Phrases that indicate direct experience or verification ("I watched it", "it happened", "confirmed", "saw") flip the decision—when combined with death/reveal signals this triggers HIGH risk and remove.
- Excerpt selection: For long content we extract up to MAX_LLM_CANDIDATES (default 5) excerpts prioritized by signal hits, then sampled windows—each excerpt is capped (MAX_LLM_EXCERPT_CHARS, default ~1800).
- LLM usage: The LLM runs only on those candidate excerpts (and only if a subreddit API key is configured). It returns a structured SpoilerDecision per excerpt.
- Aggregation: We aggregate chunk/excerpt decisions by taking the most severe risk_level / visibility_risk / recommended_action and merging reasoning; spoiler type chosen by priority.
- Normalization & platform limits: Final recommended_action is normalized for post vs comment contexts (e.g., different visibility actions). We respect limits: title 300 chars, post body 40000, comment fallback used for shorter thresholds.
- Fast-paths & efficiency: Pure-speculation -> LOW short-circuit; explicit-confirmation + reveal -> immediate HIGH/remove short-circuit; sampling plus signal-priority keeps LLM calls low.
