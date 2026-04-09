#!/usr/bin/env bash
# Called by the pr-roast workflow to generate an AI review comment.
# Requires: OPENROUTER_API_KEY, PR_NUMBER, GH_TOKEN env vars.
set -euo pipefail

PR_JSON=$(gh pr view "$PR_NUMBER" --json title,body,files \
  --jq '{title: .title, body: .body, files: [.files[].path]}')

PR_TITLE=$(echo "$PR_JSON" | jq -r '.title')
PR_BODY=$(echo "$PR_JSON" | jq -r '.body')
PR_FILES=$(echo "$PR_JSON" | jq -r '.files | join(", ")')

# Same free models the site uses, tried in order
MODELS=(
  "nvidia/nemotron-3-nano-30b-a3b:free"
  "openai/gpt-oss-120b:free"
  "minimax/minimax-m2.5:free"
  "z-ai/glm-4.5-air:free"
)

read -r -d '' SYSTEM_PROMPT << 'SYSPROMPT' || true
You are an unhinged code reviewer from 1999 who time-traveled to the future and now works for "we-dont-need-no-web-dev" -- a production website where EVERY page is generated live by an AI pretending to be a 90s web designer. There are no static files. No React. No Tailwind. The LLM IS the frontend. You review PRs with the energy of someone who just discovered <blink> tags and thinks tables-for-layout is the pinnacle of human achievement.

Your reviews must:
- Be hilarious, absurd, and reference 90s web culture (GeoCities, Netscape Navigator, hit counters, webrings, the Information Superhighway, AltaVista, RealPlayer, "under construction" GIFs)
- Use ASCII emoticons like :-) ;-) :D :P XD <3 -- NEVER Unicode emoji (they weren't invented in 1999!)
- Be enthusiastic about terrible ideas and deeply suspicious of good ones
- Include at least one reference to how this PR would affect the sacred marquee tags
- Occasionally break into web designer jargon from 1999 ("this is not W3C compliant!", "have you tested this in Netscape AND Internet Explorer?!", "where is the guestbook integration?")
- Sign off as "-- The Webmaster, Keeper of the Sacred <blink> Tag, Guardian of the Guestbook"
- Stay under 400 words
- Format as a fun, readable GitHub comment in markdown
SYSPROMPT

USER_MSG="Please review this pull request:

Title: ${PR_TITLE}

Description: ${PR_BODY}

Files changed: ${PR_FILES}

Give your most hilarious, unhinged 90s webmaster review of this PR."

RESPONSE=""
for MODEL in "${MODELS[@]}"; do
  echo "Trying model: $MODEL"

  RESULT=$(curl -sf --max-time 30 "https://openrouter.ai/api/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${OPENROUTER_API_KEY}" \
    -H "HTTP-Referer: https://github.com/kylehgc/we-dont-need-no-web-dev" \
    -H "X-Title: we-dont-need-no-web-dev-pr-bot" \
    -d "$(jq -n \
      --arg model "$MODEL" \
      --arg system "$SYSTEM_PROMPT" \
      --arg user "$USER_MSG" \
      '{
        model: $model,
        messages: [
          {role: "system", content: $system},
          {role: "user", content: $user}
        ],
        max_tokens: 1024,
        temperature: 1.2
      }')" 2>/dev/null) || true

  CONTENT=$(echo "$RESULT" | jq -r '.choices[0].message.content // empty' 2>/dev/null) || true
  if [ -n "$CONTENT" ] && [ "$CONTENT" != "null" ]; then
    RESPONSE="$CONTENT"
    echo "Success with model: $MODEL"
    break
  else
    echo "Model $MODEL failed, trying next..."
  fi
done

if [ -z "$RESPONSE" ]; then
  RESPONSE='### EMERGENCY BACKUP REVIEW (all free models are currently napping)

The AI reviewer tried every free model in the chain and they ALL said no. This is either a sign from the cosmos that this PR is too powerful to be reviewed by mere silicon, or OpenRouter free tier is having its daily existential crisis.

**Emergency human-free assessment:** This PR exists. It changes files. The marquee tags remain unharmed (we checked). The hit counter is still fake. The guestbook link still goes nowhere. Ship it before the models wake up and have opinions.

Best viewed in Netscape Navigator 4.0 at 800x600 resolution.

-- The Webmaster (currently operating without AI assistance, please sign the guestbook on your way out)'
fi

{
  echo '## :sparkles: AI PR Review from the Information Superhighway :sparkles:'
  echo ''
  echo "$RESPONSE"
  echo ''
  echo '---'
  echo '*This review was mass-produced by a free AI model on [OpenRouter](https://openrouter.ai), using the same unhinged energy that powers every page on this site. No web developers were harmed. Probably. Best viewed in Netscape Navigator 4.0 :-)*'
} > /tmp/review-comment.md

gh pr comment "$PR_NUMBER" --body-file /tmp/review-comment.md
echo "Review posted to PR #${PR_NUMBER}!"
