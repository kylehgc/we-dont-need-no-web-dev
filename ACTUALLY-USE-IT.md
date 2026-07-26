# Actually Using This Thing

fr fr no jokes here. well, maybe a few.

## Prerequisites

- [Node.js](https://nodejs.org/) installed
- A free [OpenRouter](https://openrouter.ai) account + API key ([get one here](https://openrouter.ai/keys))

## Local Development

```bash
# Clone it
git clone https://github.com/kylehgc/we-dont-need-no-web-dev.git
cd we-dont-need-no-web-dev

# Set your OpenRouter API key
cp .dev.vars.example .dev.vars
# then edit .dev.vars and paste your key in

# Run the dev server
npm run dev
```

Visit `http://localhost:8788` — or any path you want.

> **Windows on ARM64:** `wrangler dev` won't run. It depends on `workerd`, which
> Cloudflare doesn't ship a `win32-arm64` build for. Use `npm test` for local
> verification and deploy to a preview branch for the real thing.

## Tests

```bash
npm test
```

Stubs `fetch` with a fake OpenRouter stream and checks routing, streaming,
script injection, and the emergency fallback. No key or network needed.

## Deploy to Cloudflare Pages

### Option A: Dashboard (recommended)

1. Push to GitHub
2. Go to [Cloudflare dashboard → Workers & Pages → Create → Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages/create/pages)
3. Connect the repo
4. Leave **build command** empty and set **build output directory** to `public`
5. Deploy — `functions/[[path]].js` is picked up automatically, no build step

`public/` is intentionally empty. Anything you put there is served as a static
file and shadows the function, and pointing the output directory at the repo
root would publish `README.md`, `package.json`, and friends.

### Option B: CLI

```bash
npx wrangler pages deploy public
```

### Set the Environment Variable

In your Pages project: **Settings → Variables and Secrets**

| Key                  | Type   | Value                      |
| -------------------- | ------ | -------------------------- |
| `OPENROUTER_API_KEY` | Secret | `sk-or-v1-your-key-here`   |
| `CF_BEACON_TOKEN`    | Text   | (optional, see below)      |

Add it to **both** Production and Preview, then redeploy.

## Analytics (optional)

Cloudflare Web Analytics is off unless you set `CF_BEACON_TOKEN`. Grab a token
from **Cloudflare dashboard → Analytics & Logs → Web Analytics**, add it as a
variable, and the beacon gets injected before `</body>`. Leave it unset and no
script tag is emitted at all — which is arguably more in the spirit of a site
that claims to ship no JavaScript.

## Keeping the bill at zero

Every crawler hit is a full LLM generation, which is how the previous host's
usage limits got eaten. The code-side guards:

- `/robots.txt` is served directly by the function and disallows everything but `/`.
- Obvious vuln-scanner probes (`/wp-login.php`, `/.env`, `*.php`, ...) get a static 404.
- The model race is hedged, so a normal page view costs one OpenRouter request, not four.

And two dashboard toggles the code can't do for you:

- **Bot Fight Mode** under **Security → Bots**.
- A **rate limiting rule** under **Security → WAF → Rate limiting rules** (the
  free plan includes one) — there is no in-code rate limit, so one curl loop
  can otherwise drain the OpenRouter daily quota on the server's key.

Cloudflare's free tier gives 100k requests/day and unmetered bandwidth. The one
limit worth watching is **10ms CPU per request** — time spent waiting on
OpenRouter doesn't count, but the per-token stream transform does. If you start
seeing `Error 1102`, the $5/mo Workers Paid plan raises it to 30s.

## Query Parameters

| Param                        | Effect                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `?long=true`                 | Starts the model chain with a larger, slower model (NVIDIA Nemotron 3 Super 120B)            |
| `?model=provider/model-name` | Override the model — use any model ID from [OpenRouter models](https://openrouter.ai/models) |
| `?key=sk-or-v1-xxx`          | Override the API key (useful for testing with your own key)                                  |

## Project Structure

```
.
├── functions/
│   └── [[path]].js       # The one and only function. Catch-all — the filename IS the router.
├── public/               # Deliberately empty. Pages needs a build output dir.
├── test.mjs              # Dependency-free smoke tests (npm test)
├── .github/              # PR roast bot (reviews every PR as a 1999 webmaster)
├── package.json
├── .dev.vars.example     # Template for local environment variables
├── README.md             # The unhinged one
└── ACTUALLY-USE-IT.md    # You are here
```

There is no `vercel.json` equivalent. `[[path]]` is Cloudflare's catch-all
convention, so every route lands in that one file with no config.

## Free Models (Hedged Race)

The first model in the chain gets a ~2 second head start. If it hasn't answered
by then — or fails outright — the next lane opens while the first keeps running,
and the first model to respond wins. A healthy fast model costs exactly one
OpenRouter request per page view; the free tier's shared daily request cap is
why losing lanes aren't fired preemptively.

**Fast (default):**

1. `nvidia/nemotron-3-nano-30b-a3b:free`
2. `openai/gpt-oss-120b:free`
3. `minimax/minimax-m2.5:free`
4. `z-ai/glm-4.5-air:free`

Order matters now: lane 1 is the model you actually expect to serve most
traffic, the rest are insurance.

**Full (`?long=true`):**

1. `nvidia/nemotron-3-super-120b-a12b:free`
2. `openai/gpt-oss-120b:free`
3. `minimax/minimax-m2.5:free`
4. `z-ai/glm-4.5-air:free`

Check [openrouter.ai/models?q=free](https://openrouter.ai/models?q=free) for the current free model list — these change over time.

If every model in the chain fails, the server returns a built-in emergency page or docs page so the request still succeeds with something human-readable.
