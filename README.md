# Spoiler Senser

Spoiler Senser is a Devvit moderation app that detects likely spoilers in new posts and comments.

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
- Alerts moderators via Modmail and/or Discord webhook with the classifier JSON.

## Setup

1. Install the app in your subreddit.
2. Open app settings and set:
   - Subreddit settings:

- `spoilerLlmApiKey` (per-subreddit OpenAI API key)
- `spoilerLlmModel` (default: `gpt-4o-mini`)
  - `alertMode` (`modmail` | `discord` | `both`, default: `both`)
  - `alertDiscordWebhookUrl` (per-subreddit webhook; required for Discord modes)

If no API key is configured, Spoiler Senser still runs in fallback heuristic mode.

## Fetch Domains

The following domains are requested for this app:

- `api.openai.com` - Used by the server-side spoiler classifier to call OpenAI chat completions.
- `discord.com` - Used to send moderator alert webhooks when `alertMode` includes Discord.
- `discordapp.com` - Backward-compatible Discord webhook host support.
