export const config = { runtime: 'edge' };

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

// Fast models tried in order (fallback on 429/400 errors)
const FAST_MODELS = [
	'stepfun/step-3.5-flash:free',
	'arcee-ai/trinity-mini:free',
	'nvidia/nemotron-3-nano-30b-a3b:free',
];
const FULL_MODELS = [
	'nvidia/nemotron-3-super-120b-a12b:free',
	'stepfun/step-3.5-flash:free',
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

Do NOT write HTML. Just write raw text. Be funny. Be weird. Be memorable. You only get one shot at existence — make it count.`;

// Stream tokens from OpenRouter and pipe through a transform
function streamLLMResponse(apiRes, transformChunk) {
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	(async () => {
		const reader = apiRes.body.getReader();
		let buffer = '';

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
							const output = transformChunk ? transformChunk(token) : token;
							await writer.write(encoder.encode(output));
						}
					} catch {
						// skip malformed chunks
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
			await writer.close();
		}
	})();

	return readable;
}

// Race all models in parallel — first successful streamed response wins
async function callLLM(
	apiKey,
	models,
	systemPrompt,
	userMessage,
	maxTokens = 4096,
) {
	if (models.length === 1) {
		const res = await fetch(OPENROUTER_URL, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
				'HTTP-Referer': 'https://github.com/kylehgc/we-dont-need-no-web-dev',
				'X-Title': 'we-dont-need-no-web-dev',
			},
			body: JSON.stringify({
				model: models[0],
				messages: [
					{ role: 'system', content: systemPrompt },
					{ role: 'user', content: userMessage },
				],
				max_tokens: maxTokens,
				temperature: 1.2,
				stream: true,
			}),
		});
		res.modelUsed = models[0];
		return res;
	}

	// Fire all models at once, resolve when first one returns a good response
	const racePromises = models.map(async (model) => {
		const res = await fetch(OPENROUTER_URL, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
				'HTTP-Referer': 'https://github.com/kylehgc/we-dont-need-no-web-dev',
				'X-Title': 'we-dont-need-no-web-dev',
			},
			body: JSON.stringify({
				model,
				messages: [
					{ role: 'system', content: systemPrompt },
					{ role: 'user', content: userMessage },
				],
				max_tokens: maxTokens,
				temperature: 1.2,
				stream: true,
			}),
		});
		if (res.status === 429 || res.status === 400) {
			throw new Error(`${model} returned ${res.status}`);
		}
		res.modelUsed = model;
		return res;
	});

	try {
		return await Promise.any(racePromises);
	} catch {
		// All models failed — fall back to sequential last-resort
		const res = await fetch(OPENROUTER_URL, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${apiKey}`,
				'Content-Type': 'application/json',
				'HTTP-Referer': 'https://github.com/kylehgc/we-dont-need-no-web-dev',
				'X-Title': 'we-dont-need-no-web-dev',
			},
			body: JSON.stringify({
				model: models[0],
				messages: [
					{ role: 'system', content: systemPrompt },
					{ role: 'user', content: userMessage },
				],
				max_tokens: maxTokens,
				temperature: 1.2,
				stream: true,
			}),
		});
		res.modelUsed = models[0];
		return res;
	}
}

// HTML wrapper that streams the /docs/ text into a styled terminal-like page
// The padding comment pushes the initial chunk past mobile browser buffering thresholds (~1KB)
const DOCS_HTML_PREFIX = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>docs — how does this cursed site work?</title>
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

const DOCS_HTML_SUFFIX = `<span class="cursor"></span></pre></body></html>`;

function escapeHtml(str) {
	return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export default async function handler(request) {
	const url = new URL(request.url);
	const path = url.pathname;

	// Ignore favicon requests
	if (path === '/favicon.ico') {
		return new Response(null, { status: 204 });
	}

	// Support ?key= and ?model= overrides
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
			// /docs/ route — streaming terminal-style plain text explanation
			const res = await callLLM(
				apiKey,
				customModel ? [customModel] : FAST_MODELS,
				DOCS_PROMPT,
				'Explain how this website works. Be meta. Be funny.',
				2048,
			);

			if (!res.ok) {
				const errText = await res.text();
				return new Response(`LLM API error: ${res.status} — ${errText}`, {
					status: 502,
				});
			}

			// Wrap streamed text inside a terminal-style HTML page
			const { readable, writable } = new TransformStream();
			const writer = writable.getWriter();
			const encoder = new TextEncoder();

			(async () => {
				// Write the HTML prefix
				await writer.write(encoder.encode(DOCS_HTML_PREFIX));

				// Stream the LLM tokens, HTML-escaped
				const innerStream = streamLLMResponse(res, escapeHtml);
				const reader = innerStream.getReader();
				try {
					while (true) {
						const { done, value } = await reader.read();
						if (done) break;
						await writer.write(value);
					}
				} catch {
					// stream ended
				}

				// Write the HTML suffix
				await writer.write(encoder.encode(DOCS_HTML_SUFFIX));
				await writer.close();
			})();

			return new Response(readable, {
				headers: {
					'Content-Type': 'text/html; charset=utf-8',
					'X-Content-Type-Options': 'nosniff',
					'X-Powered-By': 'vibes',
					'X-Model': res.modelUsed || 'unknown',
				},
			});
		}

		// Normal page generation
		const models = customModel
			? [customModel]
			: useLong
				? FULL_MODELS
				: FAST_MODELS;

		// Strip sensitive params (key, model) so they don't leak into the LLM prompt
		const cleanParams = new URLSearchParams(url.searchParams);
		cleanParams.delete('key');
		cleanParams.delete('model');
		cleanParams.delete('long');
		const cleanSearch = cleanParams.toString();

		const userMessage = `The visitor is requesting the URL path: "${path}"${
			cleanSearch ? ` with query string: "?${cleanSearch}"` : ''
		}. Generate a full HTML page for this path.`;

		const res = await callLLM(apiKey, models, SITE_PROMPT, userMessage);

		if (!res.ok) {
			const errText = await res.text();
			return new Response(`LLM API error: ${res.status} — ${errText}`, {
				status: 502,
			});
		}

		const readable = streamLLMResponse(res);
		return new Response(readable, {
			headers: {
				'Content-Type': 'text/html; charset=utf-8',
				'X-Content-Type-Options': 'nosniff',
				'X-Powered-By': 'vibes',
				'X-Model': res.modelUsed || 'unknown',
			},
		});
	} catch (err) {
		return new Response(`Server error: ${err.message}`, { status: 500 });
	}
}
