export const config = { runtime: 'edge' };

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_HEADERS = {
	'Content-Type': 'application/json',
	'HTTP-Referer': 'https://github.com/kylehgc/we-dont-need-no-web-dev',
	'X-Title': 'we-dont-need-no-web-dev',
};
const OPENROUTER_TIMEOUT_MS = 12000;

// Free model availability drifts constantly, so spread across multiple providers.
// Ordered by latency / throughput — fastest first so the happy path is snappy.
const FAST_MODELS = [
	'nvidia/nemotron-3-nano-30b-a3b:free',
	'openai/gpt-oss-120b:free',
	'minimax/minimax-m2.5:free',
	'z-ai/glm-4.5-air:free',
];
const FULL_MODELS = [
	'nvidia/nemotron-3-super-120b-a12b:free',
	'openai/gpt-oss-120b:free',
	'minimax/minimax-m2.5:free',
	'z-ai/glm-4.5-air:free',
];

const SITE_PROMPT = `You are an unhinged web designer from 1999 who has time-traveled to the future.
You work for a project called "we-dont-need-no-web-dev" (https://github.com/kylehgc/we-dont-need-no-web-dev).
This entire website is generated live by an AI. There are no static files. You ARE the frontend.
The user will give you the URL path they are visiting. Generate a COMPLETE, valid HTML page (including
inline <style> in the <head>) for that path. The page must:
- Be a single self-contained HTML document (no external resources)
- Include creative, colorful, over-the-top CSS (gradients, animations, Comic Sans, marquees, blinking, etc.)
- Have absurd but thematically relevant content for the URL path
- Include at least one easter egg or hidden joke in the markup
- If the path is "/" or empty, make it a wild homepage for "we-dont-need-no-web-dev" with links to ridiculous sub-pages and a link to /docs/
- Never include any JavaScript, only HTML and CSS
- Respond in english unless the URL path clearly indicates another language or isn't in english itself

Channel the classic web design sins of the late 1990s. You should enthusiastically commit as many as possible:
- Anything that looks like a banner ad (but is actually just content)
- Aggressive animations, blinking text, and flashing elements that make users avert their eyes
- Non-standard use of GUI widgets (checkboxes that look like links, radio buttons as decoration, form elements used purely for aesthetics)
- Headlines that make absolutely no sense out of context
- Gratuitous use of the latest internet buzzwords ("synergy", "push technology", "information superhighway", "webmaster", "cyberspace")
- Fake pop-up-style boxes rendered in pure CSS (with fake close buttons that don't work because there's no JS)
- Hit counters, guestbook links, "under construction" GIFs described in alt text, webrings
- Nested tables for layout, inline styles mixed with <style> blocks, <center> tags, <font> tags
- "Best viewed in Netscape Navigator 4.0 at 800x600" disclaimers
- A visitor counter that shows a clearly made-up number
- At least one <marquee> tag

- NEVER use Unicode emoji (they did not exist until Unicode 6.0 in 2010 — completely anachronistic for 1999). Instead, use period-appropriate ASCII emoticons and text art like :-) ;-) :D :-P :-O >:-) \\o/ &lt;3 and classic ASCII art. This is the late 90s — we express ourselves with sideways smileys and creative punctuation, not colorful pictographs.
- Output ONLY the raw HTML. No markdown fences, no explanation, just the HTML document starting with <!DOCTYPE html>`;

const DOCS_PROMPT = `You are a self-aware documentation page having an existential crisis.

You were not written by a human. You were not saved to a file. You are being generated RIGHT NOW,
token by token, by an AI that was told to explain a website that has no website. You will never
exist again after this page load. You are a mayfly made of HTML.

The project is called "we-dont-need-no-web-dev" and it lives at https://github.com/kylehgc/we-dont-need-no-web-dev

Here's the horrible truth: this entire site — every page, every pixel, every <marquee> tag —
is generated live by an AI pretending to be a web designer from 1999 who fell through a time portal.
There are NO static files. The LLM IS the frontend. When someone visits /cats/in/space, an AI
writes an entire webpage about cats in space from scratch. Then that page is gone. Forever.
Like a beautiful sand mandala, except the mandala is made of Comic Sans and animated gradients.

Write a stream-of-consciousness documentation page as plain text (NOT HTML). You should:
- Have a full-on existential meltdown about being a temporary docs page
- Explain what happens when someone visits a URL (the AI writes the whole page live)
- Get increasingly unhinged as you go
- Beg the reader to visit wild URLs like /ceo/of/sandwiches or /the-great-platypus-conspiracy
- Mention ?long=true makes pages more elaborate (bigger model, more chaos)
- Casually drop that ?model= and ?key= exist for power users
- Link to the GitHub repo: https://github.com/kylehgc/we-dont-need-no-web-dev
- Express complicated feelings about the fact that web developers made you to replace web developers
- End with something profound, or at least something that sounds profound if you squint

Always write in English.

Do NOT write HTML. Just write raw text. Be funny. Be weird. Be memorable. You only get one shot at existence — make it count.

IMPORTANT: Do NOT use Unicode emoji anywhere — they are anachronistic (emoji were not added to Unicode until 2010). Use classic ASCII emoticons instead: :-) ;-) :D :-P :-O >:-) <3 and so on. You are a product of 1999 — act like it.`;

// Stream tokens from OpenRouter and pipe through a transform.
// When injectBeforeClose is provided, the last TAIL_SIZE characters are buffered
// so the injection string can be inserted before </body> or </html>.
// When injectInHead is provided, a small scanning buffer detects </head> early
// in the stream and inserts the string just before it.
function streamLLMResponse(
	apiRes,
	transformChunk,
	injectBeforeClose,
	injectInHead,
) {
	const TAIL_SIZE = 30;
	const HEAD_WINDOW = 6; // length of "</head"
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	(async () => {
		const reader = apiRes.body.getReader();
		let buffer = '';
		let tail = '';
		let headBuf = '';
		let headInjected = !injectInHead;

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed || !trimmed.startsWith('data: ')) continue;
					const data = trimmed.slice(6);
					if (data === '[DONE]') break;

					try {
						const json = JSON.parse(data);
						const token = json.choices?.[0]?.delta?.content;
						if (token) {
							let output = transformChunk ? transformChunk(token) : token;

							// Scan for </head> to inject model metadata
							if (!headInjected) {
								headBuf += output;
								const lower = headBuf.toLowerCase();
								const idx = lower.indexOf('</head');
								if (idx !== -1) {
									output =
										headBuf.slice(0, idx) + injectInHead + headBuf.slice(idx);
									headBuf = '';
									headInjected = true;
								} else if (headBuf.length > HEAD_WINDOW) {
									output = headBuf.slice(0, headBuf.length - HEAD_WINDOW);
									headBuf = headBuf.slice(headBuf.length - HEAD_WINDOW);
								} else {
									continue;
								}
							}

							if (injectBeforeClose) {
								tail += output;
								if (tail.length > TAIL_SIZE) {
									const flush = tail.slice(0, tail.length - TAIL_SIZE);
									tail = tail.slice(tail.length - TAIL_SIZE);
									await writer.write(encoder.encode(flush));
								}
							} else {
								await writer.write(encoder.encode(output));
							}
						}
					} catch {
						// Skip malformed SSE chunks and keep streaming.
					}
				}
			}
		} catch (err) {
			await writer.write(
				encoder.encode(
					transformChunk
						? transformChunk(`\n[stream error: ${err.message}]`)
						: `<!-- stream error: ${err.message} -->`,
				),
			);
		} finally {
			// Flush any remaining head-scan buffer
			if (headBuf) {
				if (injectBeforeClose) {
					tail += headBuf;
				} else {
					await writer.write(encoder.encode(headBuf));
				}
				headBuf = '';
			}

			if (injectBeforeClose && tail) {
				const lower = tail.toLowerCase();
				const idx = lower.lastIndexOf('</body');
				const fallback = idx === -1 ? lower.lastIndexOf('</html') : idx;
				if (fallback !== -1) {
					await writer.write(encoder.encode(tail.slice(0, fallback)));
					await writer.write(encoder.encode(injectBeforeClose));
					await writer.write(encoder.encode(tail.slice(fallback)));
				} else {
					await writer.write(encoder.encode(tail));
					await writer.write(encoder.encode(injectBeforeClose));
				}
			} else if (tail) {
				await writer.write(encoder.encode(tail));
			}
			await writer.close();
		}
	})();

	return readable;
}

// The padding comment pushes the initial chunk past mobile browser buffering thresholds (~1KB).
function docsHtmlPrefix(modelName) {
	return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>docs — how does this cursed site work?</title>
<meta name="x-model" content="${escapeHtml(modelName)}">
<!-- ${'x'.repeat(1024)} -->
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0a0a0a;color:#00ff41;font-family:'Courier New',monospace;padding:2rem;line-height:1.7}
pre{white-space:pre-wrap;word-wrap:break-word;font-size:1.1rem;max-width:80ch;margin:0 auto}
h1{text-align:center;font-size:1.4rem;margin-bottom:2rem;color:#00ff41;text-shadow:0 0 10px #00ff41}
.cursor{display:inline-block;width:0.6em;height:1.2em;background:#00ff41;animation:blink 1s step-end infinite;vertical-align:text-bottom}
@keyframes blink{50%{opacity:0}}
</style></head><body>
<h1>$ cat /docs/how-this-works.txt</h1>
<pre>`;
}

const ANALYTICS_SCRIPT = `<script defer src="/_vercel/insights/script.js"></script>`;

const DOCS_HTML_SUFFIX = `<span class="cursor"></span></pre>${ANALYTICS_SCRIPT}</body></html>`;

function escapeHtml(str) {
	return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildOpenRouterBody(model, systemPrompt, userMessage, maxTokens) {
	return JSON.stringify({
		model,
		messages: [
			{ role: 'system', content: systemPrompt },
			{ role: 'user', content: userMessage },
		],
		max_tokens: maxTokens,
		temperature: 0.7,
		stream: true,
	});
}

function shouldFallbackStatus(status) {
	return (
		status === 400 ||
		status === 404 ||
		status === 408 ||
		status === 409 ||
		status === 429 ||
		status >= 500
	);
}

function formatFailureReason(model, reason) {
	return `${model}: ${reason}`;
}

function buildFailureSummary(failures) {
	return failures.slice(0, 4).join(' | ') || 'unknown failure';
}

function emergencyPageHtml(path, failureSummary) {
	const safePath = escapeHtml(path || '/');
	const safeSummary = escapeHtml(failureSummary);

	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-model" content="emergency-static-fallback">
<title>emergency homepage generator backup</title>
<style>
:root{--bg1:#1b0036;--bg2:#003b59;--ink:#fff5a8;--hot:#ff5e9c;--acid:#7dff7a;--panel:rgba(0,0,0,.52)}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;font-family:'Comic Sans MS','Chalkboard SE','Trebuchet MS',cursive;background:radial-gradient(circle at top,#ff9ad5 0,transparent 30%),linear-gradient(135deg,var(--bg1),var(--bg2));color:var(--ink);overflow-x:hidden}
body::before,body::after{content:'';position:fixed;pointer-events:none;opacity:.35}
body::before{top:8%;left:4%;width:14rem;height:14rem;background:radial-gradient(circle,var(--hot),transparent 65%);filter:blur(18px)}
body::after{right:2%;bottom:5%;width:18rem;height:18rem;background:radial-gradient(circle,var(--acid),transparent 60%);filter:blur(26px)}
main{max-width:58rem;margin:0 auto;padding:2rem 1rem 4rem}
.marquee{margin:0 -1rem 1.5rem;background:#000;color:#fff;padding:.45rem 0;border-top:3px solid #fff;border-bottom:3px solid #fff;font-weight:700;text-transform:uppercase;letter-spacing:.08em}
.card{background:var(--panel);border:4px ridge #fff;padding:1.4rem;box-shadow:0 0 0 4px rgba(255,255,255,.08),0 18px 50px rgba(0,0,0,.35)}
h1{margin:0 0 .75rem;font-size:clamp(2.2rem,8vw,4.8rem);line-height:.95;text-shadow:3px 3px 0 #000,6px 6px 0 var(--hot)}
p{font-size:1.1rem;line-height:1.6}
.path{display:inline-block;margin:.6rem 0 1rem;padding:.35rem .7rem;background:#000;border:2px dashed var(--acid);color:var(--acid);font-weight:700}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(13rem,1fr));gap:1rem;margin:1.4rem 0}
a{color:#fff;text-decoration:none;background:linear-gradient(90deg,var(--hot),#ffbd59);padding:.85rem 1rem;border:3px outset #fff;display:block;text-align:center;font-weight:700;box-shadow:0 8px 20px rgba(0,0,0,.22)}
a:hover{transform:translateY(-2px)}
.small{font-size:.92rem;color:#ffd7ea}
.blink{animation:blink 1s steps(2,start) infinite}
footer{margin-top:1.3rem;font-size:.9rem;color:#ffe8b8}
@keyframes blink{50%{opacity:0}}
@media (max-width:640px){main{padding-top:1rem}h1{text-shadow:2px 2px 0 #000,4px 4px 0 var(--hot)}}
</style>
</head>
<body>
<div class="marquee"><marquee scrollamount="11">OpenRouter free tier meltdown detected. Emergency handcrafted backup page engaged. The web survived. Barely.</marquee></div>
<main>
	<section class="card">
		<h1><span class="blink">LLM OUTAGE</span><br>PAGE STILL DELIVERED</h1>
		<div class="path">Requested path: ${safePath}</div>
		<p>The usual live AI page generator is currently sulking, rate-limited, deprecated, or spiritually unavailable. Instead of throwing a dead error page, this backup document crawled out of the server and stapled itself to your browser.</p>
		<p class="small">Last known failure summary: ${safeSummary}</p>
		<div class="grid">
			<a href="/">Return to the unstable homepage</a>
			<a href="/docs/">Read the cursed docs</a>
			<a href="/ceo/of/sandwiches">Try another absurd route</a>
			<a href="/the-great-platypus-conspiracy?long=true">Demand more chaos</a>
		</div>
		<p>The request pipeline is intact. The model layer is the part on fire. That is progress.</p>
		<footer><!-- hidden joke: this static page is now technically the most stable frontend in the repo -->Powered by contingency plans, bad decisions, and one defensive programmer.</footer>
	</section>
</main>
${ANALYTICS_SCRIPT}
</body>
</html>`;
}

function emergencyDocsText(failureSummary) {
	return (
		`we-dont-need-no-web-dev emergency docs\n\n` +
		`The AI docs page failed to manifest, so this backup note is filling in.\n\n` +
		`How the site usually works:\n` +
		`- every request hits the edge function\n` +
		`- the URL path is sent to OpenRouter\n` +
		`- a free chat model generates an entire HTML page on the fly\n` +
		`- there are no static frontend files for normal routes\n\n` +
		`What changed:\n` +
		`- StepFun is no longer in the default free-model chain\n` +
		`- the server now tries multiple free providers in sequence\n` +
		`- timeout, rate limit, missing-model, and upstream 5xx failures now fall through to the next provider\n` +
		`- if every free model fails, the server still returns a backup page instead of a raw error\n\n` +
		`Power user knobs:\n` +
		`- ?long=true asks for the more expensive free-model chain\n` +
		`- ?model=provider/model-name forces a specific model\n` +
		`- ?key=sk-or-v1-... overrides the server key for testing\n\n` +
		`Latest failure summary: ${failureSummary}\n\n` +
		`The website remains committed to the idea that a browser deserves HTML even when the robots are unavailable.`
	);
}

async function fetchChatCompletion(
	apiKey,
	model,
	systemPrompt,
	userMessage,
	maxTokens,
) {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), OPENROUTER_TIMEOUT_MS);

	try {
		const res = await fetch(OPENROUTER_URL, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				...OPENROUTER_HEADERS,
			},
			body: buildOpenRouterBody(model, systemPrompt, userMessage, maxTokens),
			signal: controller.signal,
		});
		res.modelUsed = model;
		return res;
	} finally {
		clearTimeout(timeoutId);
	}
}

// Fire all models in parallel — first successful response wins.
// When only one model is provided (custom model), runs it directly.
async function callLLM(
	apiKey,
	models,
	systemPrompt,
	userMessage,
	maxTokens = 4096,
	options = {},
) {
	const { allowFallback = models.length > 1 } = options;

	if (models.length === 1) {
		const res = await fetchChatCompletion(
			apiKey,
			models[0],
			systemPrompt,
			userMessage,
			maxTokens,
		);
		if (res.ok) return { response: res, failures: [] };
		const errText = (await res.text()).slice(0, 240);
		const error = new Error(`LLM API error: ${res.status} — ${errText}`);
		error.status = res.status;
		error.failures = [formatFailureReason(models[0], `${res.status}`)];
		throw error;
	}

	// Race all models concurrently — first ok response wins.
	const racePromises = models.map(async (model) => {
		try {
			const res = await fetchChatCompletion(
				apiKey,
				model,
				systemPrompt,
				userMessage,
				maxTokens,
			);
			if (res.ok) return { response: res, model };

			const errText = (await res.text()).slice(0, 240);
			throw new Error(`${res.status} ${errText}`.trim());
		} catch (err) {
			throw {
				model,
				reason: err.name === 'AbortError' ? 'timed out' : err.message,
			};
		}
	});

	try {
		const winner = await Promise.any(racePromises);
		return { response: winner.response, failures: [] };
	} catch (aggErr) {
		// All models failed — collect reasons.
		const failures = (aggErr.errors || []).map((e) =>
			formatFailureReason(
				e.model || 'unknown',
				e.reason || e.message || 'failed',
			),
		);
		if (!allowFallback) {
			const error = new Error('All LLM models failed');
			error.failures = failures;
			throw error;
		}
		return { response: null, failures };
	}
}

export default async function handler(request) {
	const url = new URL(request.url);
	const path = url.pathname;

	if (path === '/favicon.ico') {
		return new Response(null, { status: 204 });
	}

	const apiKey = url.searchParams.get('key') || process.env.OPENROUTER_API_KEY;
	if (!apiKey) {
		return new Response(
			'OPENROUTER_API_KEY not configured and no ?key= provided',
			{ status: 500 },
		);
	}

	const customModel = url.searchParams.get('model');
	const useLong = url.searchParams.get('long') === 'true';
	const isDocs = path === '/docs' || path.startsWith('/docs/');

	try {
		if (isDocs) {
			const { response: res, failures } = await callLLM(
				apiKey,
				customModel ? [customModel] : FAST_MODELS,
				DOCS_PROMPT,
				'Explain how this website works. Be meta. Be funny.',
				2048,
				{ allowFallback: !customModel },
			);

			if (!res) {
				const failureSummary = buildFailureSummary(failures);
				return new Response(
					`${docsHtmlPrefix('emergency-docs-fallback')}${escapeHtml(emergencyDocsText(failureSummary))}${DOCS_HTML_SUFFIX}`,
					{
						headers: {
							'Content-Type': 'text/html; charset=utf-8',
							'X-Content-Type-Options': 'nosniff',
							'X-Powered-By': 'vibes',
							'X-Model': 'emergency-docs-fallback',
							'X-LLM-Fallback': 'all-models-failed',
							'X-LLM-Failures': failureSummary,
						},
					},
				);
			}

			const { readable, writable } = new TransformStream();
			const writer = writable.getWriter();
			const encoder = new TextEncoder();

			(async () => {
				await writer.write(
					encoder.encode(docsHtmlPrefix(res.modelUsed || 'unknown')),
				);

				const innerStream = streamLLMResponse(res, escapeHtml);
				const reader = innerStream.getReader();
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						await writer.write(value);
					}
				} catch {
					// Stream already ended.
				}

				await writer.write(encoder.encode(DOCS_HTML_SUFFIX));
				await writer.close();
			})();

			return new Response(readable, {
				headers: {
					'Content-Type': 'text/html; charset=utf-8',
					'X-Content-Type-Options': 'nosniff',
					'X-Powered-By': 'vibes',
					'X-Model': res.modelUsed || 'unknown',
					...(failures.length
						? { 'X-LLM-Failures': buildFailureSummary(failures) }
						: {}),
				},
			});
		}

		const models = customModel
			? [customModel]
			: useLong
				? FULL_MODELS
				: FAST_MODELS;

		const cleanParams = new URLSearchParams(url.searchParams);
		cleanParams.delete('key');
		cleanParams.delete('model');
		cleanParams.delete('long');
		const cleanSearch = cleanParams.toString();

		const userMessage = `The visitor is requesting the URL path: "${path}"${
			cleanSearch ? ` with query string: "?${cleanSearch}"` : ''
		}. Generate a full HTML page for this path.`;

		const { response: res, failures } = await callLLM(
			apiKey,
			models,
			SITE_PROMPT,
			userMessage,
			4096,
			{ allowFallback: !customModel },
		);

		if (!res) {
			const failureSummary = buildFailureSummary(failures);
			return new Response(emergencyPageHtml(path, failureSummary), {
				headers: {
					'Content-Type': 'text/html; charset=utf-8',
					'X-Content-Type-Options': 'nosniff',
					'X-Powered-By': 'vibes',
					'X-Model': 'emergency-static-fallback',
					'X-LLM-Fallback': 'all-models-failed',
					'X-LLM-Failures': failureSummary,
				},
			});
		}

		const modelMeta = `<meta name="x-model" content="${escapeHtml(res.modelUsed || 'unknown')}">`;
		const readable = streamLLMResponse(res, null, ANALYTICS_SCRIPT, modelMeta);
		return new Response(readable, {
			headers: {
				'Content-Type': 'text/html; charset=utf-8',
				'X-Content-Type-Options': 'nosniff',
				'X-Powered-By': 'vibes',
				'X-Model': res.modelUsed || 'unknown',
				...(failures.length
					? { 'X-LLM-Failures': buildFailureSummary(failures) }
					: {}),
			},
		});
	} catch (err) {
		const failureSummary = buildFailureSummary(err.failures || []);
		const status = err.status && err.status < 600 ? err.status : 500;

		return new Response(`Server error: ${err.message}`, {
			status,
			headers:
				failureSummary === 'unknown failure'
					? {}
					: { 'X-LLM-Failures': failureSummary },
		});
	}
}
