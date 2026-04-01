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
export OPENROUTER_API_KEY=sk-or-v1-your-key-here

# Install Vercel CLI if you don't have it
npm i -g vercel

# Run the dev server
vercel dev
```

Visit `http://localhost:3000` — or any path you want.

## Deploy to Vercel

### Option A: CLI

```bash
vercel --prod
```

### Option B: Dashboard

1. Push to GitHub
2. Go to [vercel.com/new](https://vercel.com/new)
3. Import the repo
4. It just works — no build config needed

### Set the Environment Variable

In your Vercel project: **Settings → Environment Variables**

| Key                  | Value                    |
| -------------------- | ------------------------ |
| `OPENROUTER_API_KEY` | `sk-or-v1-your-key-here` |

Or via CLI:

```bash
vercel env add OPENROUTER_API_KEY production
```

Then redeploy: `vercel --prod`

## Query Parameters

| Param                        | Effect                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `?long=true`                 | Uses a larger, slower model (NVIDIA Nemotron 3 Super 120B)                                   |
| `?model=provider/model-name` | Override the model — use any model ID from [OpenRouter models](https://openrouter.ai/models) |
| `?key=sk-or-v1-xxx`          | Override the API key (useful for testing with your own key)                                  |

## Project Structure

```
.
├── api/
│   └── index.js        # The one and only serverless edge function
├── vercel.json          # Routes all requests to the edge function
├── package.json
├── .env.example         # Template for environment variables
├── README.md            # The unhinged one
└── ACTUALLY-USE-IT.md   # You are here
```

## Free Models (Fallback Chain)

The site tries these models in order. If one returns a 429 (rate limit), it falls through to the next:

**Fast (default):**

1. `stepfun/step-3.5-flash:free`
2. `z-ai/glm-4.5-air:free`
3. `nvidia/nemotron-3-nano-30b-a3b:free`

**Full (`?long=true`):**

1. `nvidia/nemotron-3-super-120b-a12b:free`
2. `stepfun/step-3.5-flash:free`

Check [openrouter.ai/models?q=free](https://openrouter.ai/models?q=free) for the current free model list — these change over time.
