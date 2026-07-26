const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_HEADERS = {
	'Content-Type': 'application/json',
	'HTTP-Referer': 'https://github.com/kylehgc/we-dont-need-no-web-dev',
	'X-Title': 'we-dont-need-no-web-dev',
};
const OPENROUTER_TIMEOUT_MS = 12000;
// How long the winning model gets to produce its first token before we give up
// and serve the emergency page instead of holding a headerless request open.
const FIRST_BYTE_TIMEOUT_MS = 15000;
// A lane of the model race opens this long after the previous one, unless the
// previous lane has already failed outright (then the next opens immediately).
const HEDGE_MS = 2000;

// Classic vuln-scanner probe shapes: server-side extensions this site will
// never have, plus WordPress/phpMyAdmin prefixes and dotfile paths.
const SCANNER_PATHS =
	/\.(php\d?|aspx?|jsp|cgi|env|git|sql|bak|ini|config|ya?ml|lock|axd|xml)$|^\/(wp-|wordpress|phpmyadmin|xmlrpc|cgi-bin|vendor\/|\.)/i;

// Hardcoded free-model slugs rot, fast: this list went 3-of-4 dead in a single
// day ("This model is unavailable for free"), which collapsed every request
// onto one straggler and produced the emergency-page epidemic.
//
// openrouter/free is a router that picks at random from whatever free models
// exist right now, filtering for the features a request needs. Nothing to
// maintain, and because each call re-rolls, the hedge lanes below naturally
// land on different models — retry diversity for free.
const FREE_ROUTER = 'openrouter/free';
const LANES = [FREE_ROUTER, FREE_ROUTER, FREE_ROUTER, FREE_ROUTER];

// The free pool is not all general-purpose chat models: it also holds safety
// classifiers, vision encoders and code-completion models. A random roll can
// land on one, and it will answer a request for a 1999 webpage with something
// like "User Safety: safe" (observed in production). So a lane must prove it
// is producing the *right kind* of output, not merely any output.
//
// Returns true (usable), false (wrong kind — disqualify now), or undefined
// (too early to tell — keep reading).
const PROOF_WINDOW = 80;

function looksLikeHtml(content, streamEnded) {
	if (/<\s*(!doctype|html|head|body|div|center|table|font|marquee|style|h[1-6]|p\b|span|a\b)/i.test(content))
		return true;
	// Models often lead with a stray newline or a ```html fence; only judge
	// once there is enough non-markup prose to be confident it is not HTML.
	if (streamEnded || content.replace(/^[\s`]*(html)?/i, '').length > PROOF_WINDOW)
		return false;
	return undefined;
}

function looksLikeProse(content, streamEnded) {
	if (content.trim().length > 0) return true;
	return streamEnded ? false : undefined;
}

// Reasoning models bill their hidden thinking against max_tokens, so a page can
// run out of budget mid-<div> and arrive truncated. Headroom is cheap.
const MAX_TOKENS = 8192;
const MAX_TOKENS_LONG = 16384;

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
	waitUntil,
) {
	const TAIL_SIZE = 30;
	const HEAD_WINDOW = 6; // length of "</head"
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();
	const decoder = new TextDecoder();

	const pump = (async () => {
		const reader = apiRes.body.getReader();
		let buffer = '';
		let tail = '';
		let headBuf = '';
		let headInjected = !injectInHead;
		let sawDone = false;

		// Resolves once the downstream side is gone (client disconnect, watchdog
		// cancel). Raced against every upstream read so a silent model can't
		// leave this pump blocked on read() holding an outbound connection.
		const downstreamGone = writer.closed.then(
			() => true,
			() => true,
		);

		// Route one token's worth of output through the head-scan and tail
		// buffers; returns the substring that is ready to leave the function.
		const absorb = (output) => {
			if (!headInjected) {
				headBuf += output;
				const idx = headBuf.toLowerCase().indexOf('</head');
				if (idx !== -1) {
					output = headBuf.slice(0, idx) + injectInHead + headBuf.slice(idx);
					headBuf = '';
					headInjected = true;
				} else if (headBuf.length > HEAD_WINDOW) {
					output = headBuf.slice(0, headBuf.length - HEAD_WINDOW);
					headBuf = headBuf.slice(headBuf.length - HEAD_WINDOW);
				} else {
					return '';
				}
			}

			if (injectBeforeClose) {
				tail += output;
				if (tail.length <= TAIL_SIZE) return '';
				const flush = tail.slice(0, tail.length - TAIL_SIZE);
				tail = tail.slice(tail.length - TAIL_SIZE);
				return flush;
			}
			return output;
		};

		// Tracks whether the model ever closed the document. A truncated page
		// (budget exhausted mid-tag) otherwise leaves the browser parsing an
		// unterminated element and showing a blank or half-styled mess.
		let sawHtmlClose = false;

		const drainLines = (lines) => {
			// One encoded write per network chunk, not per token — the per-token
			// writes were the biggest avoidable cost against the 10ms CPU budget.
			let batch = '';
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed || !trimmed.startsWith('data: ')) continue;
				const data = trimmed.slice(6);
				if (data === '[DONE]') {
					// Terminate the whole read, not just this chunk's lines — some
					// providers keep the socket open after [DONE], which previously
					// held the response (and the connection) until their timeout.
					sawDone = true;
					break;
				}

				try {
					const token = JSON.parse(data).choices?.[0]?.delta?.content;
					if (token) {
						if (token.includes('</html')) sawHtmlClose = true;
						batch += absorb(transformChunk ? transformChunk(token) : token);
					}
				} catch {
					// Skip malformed SSE chunks and keep streaming.
				}
			}
			return batch;
		};

		try {
			while (!sawDone) {
				const next = await Promise.race([
					reader.read().then((r) => ({ r })),
					downstreamGone.then(() => null),
				]);
				if (!next) {
					reader.cancel().catch(() => {});
					return;
				}
				const { done, value } = next.r;
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split('\n');
				buffer = lines.pop() || '';

				const batch = drainLines(lines);
				if (batch) await writer.write(encoder.encode(batch));
			}
			if (sawDone) reader.cancel().catch(() => {});

			// Flush the decoder and any final unterminated SSE line — without this
			// a stream that ends without a trailing newline drops its last token.
			buffer += decoder.decode();
			if (!sawDone && buffer) {
				const batch = drainLines([buffer]);
				if (batch) await writer.write(encoder.encode(batch));
			}
		} catch (err) {
			// Best-effort: if the writer itself is what failed (client gone,
			// downstream cancelled), these writes reject too — swallow them so the
			// pump promise never becomes an unhandled rejection.
			try {
				await writer.write(
					encoder.encode(
						transformChunk
							? transformChunk(`\n[stream error: ${err.message}]`)
							: `<!-- stream error: ${err.message} -->`,
					),
				);
			} catch {}
		} finally {
			try {
				// Flush any remaining head-scan buffer
				if (headBuf) {
					if (injectBeforeClose) {
						tail += headBuf;
					} else {
						await writer.write(encoder.encode(headBuf));
					}
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

				// Truncated mid-document: close the tags ourselves so the browser
				// renders what did arrive instead of choking on an open element.
				// transformChunk means the docs route, which owns its own shell.
				if (!sawHtmlClose && !transformChunk) {
					await writer.write(
						encoder.encode(
							'\n<!-- generation ran out of budget mid-page; closing tags added by the server -->\n</body></html>',
						),
					);
				}
				await writer.close();
			} catch {
				// Downstream already errored or was cancelled — nothing to flush to.
			}
		}
	})();

	// Keep the pump alive past the point Workers has flushed response headers.
	// The docs path wraps its own outer pump instead, so this is optional.
	waitUntil?.(pump);

	return readable;
}

// A 200 from OpenRouter proves nothing: overloaded free models open the SSE
// socket, send keep-alive comments, and never produce a token ("zombies" —
// observed in production within minutes of the first deploy). This reads the
// body until an actual delta token appears, then returns a response whose body
// replays the buffered bytes ahead of the live tail, so nothing is lost.
// Returns null on timeout or a tokenless close.
//
// This is also what keeps the browser in its "waiting for document" state
// instead of painting a blank committed page: the Response isn't constructed —
// so headers can't flush — until real content provably exists.
async function proveFirstToken(res, timeoutMs, looksUsable = () => true) {
	if (!res.body) return null;
	const reader = res.body.getReader();
	const chunks = [];
	const decoder = new TextDecoder();
	let text = '';
	let content = '';
	let watchdog;
	const deadline = new Promise((r) => {
		watchdog = setTimeout(r, timeoutMs);
	});

	// Same parse the pump uses: a "data:" line whose delta has non-empty
	// content. Keep-alive comment lines (": ...") never match. Also captures
	// the real model slug, since openrouter/free hides it behind the router.
	let servedBy = null;
	const hasToken = (lines) => {
		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed.startsWith('data: ') || trimmed === 'data: [DONE]')
				continue;
			try {
				const json = JSON.parse(trimmed.slice(6));
				if (json.model) servedBy = json.model;
				const token = json.choices?.[0]?.delta?.content;
				if (token) content += token;
			} catch {
				// Malformed line — keep scanning.
			}
		}
		return content;
	};

	// Replays the buffered proof bytes, then hands over to the live tail.
	const provenBody = () => ({
		servedBy,
		body: new ReadableStream({
			start(controller) {
				for (const c of chunks) controller.enqueue(c);
			},
			async pull(controller) {
				const { done, value } = await reader.read();
				if (done) controller.close();
				else controller.enqueue(value);
			},
			cancel(reason) {
				return reader.cancel(reason);
			},
		}),
	});

	try {
		while (true) {
			const next = await Promise.race([
				reader.read().then((r) => ({ r })),
				deadline,
			]);
			if (!next) {
				reader.cancel().catch(() => {});
				return null;
			}
			if (next.r.done) {
				// Stream ended mid-proof. Flush the decoder and scan the final
				// unterminated line too — a body whose only token has no trailing
				// newline is still a proven body.
				text += decoder.decode();
				const final = hasToken(text.split('\n'));
				return final && looksUsable(final, true) ? provenBody() : null;
			}

			chunks.push(next.r.value);
			text += decoder.decode(next.r.value, { stream: true });
			const soFar = hasToken(text.split('\n').slice(0, -1));
			if (soFar) {
				const verdict = looksUsable(soFar, false);
				if (verdict === true) return provenBody();
				// Definitively wrong kind of output (a classifier verdict, a
				// refusal, prose where HTML was asked for). Disqualify the lane
				// now so the hedge can roll a different model.
				if (verdict === false) {
					reader.cancel().catch(() => {});
					return null;
				}
				// undefined: not enough output yet to judge — keep reading.
			}
		}
	} finally {
		clearTimeout(watchdog);
	}
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

// Cloudflare Web Analytics. Set CF_BEACON_TOKEN to enable; unset means no script at all.
function analyticsScript(token) {
	return token
		? `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${escapeHtml(token)}"}'></script>`
		: '';
}

function docsHtmlSuffix(analytics) {
	return `<span class="cursor"></span></pre>${analytics}</body></html>`;
}

function escapeHtml(str) {
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// Strip anything the Response constructor would reject and cap the length, so
// a crafted ?model= or a weird upstream error line can't crash header assembly
// (which would also take out the emergency fallback path that reports it).
function headerSafe(value) {
	return String(value)
		.replace(/[^\t\x20-\x7e]+/g, ' ')
		.slice(0, 256);
}

// Shared headers for every HTML response. The CSP enforces at the browser what
// SITE_PROMPT merely requests from the model: no scripts — except the beacon
// when analytics is on. Inline styles stay open; they are the whole aesthetic.
function htmlHeaders(model, failures, analytics) {
	return {
		'Content-Type': 'text/html; charset=utf-8',
		'X-Content-Type-Options': 'nosniff',
		'X-Powered-By': 'vibes',
		'X-Model': headerSafe(model),
		'Content-Security-Policy': analytics
			? "default-src 'none'; style-src 'unsafe-inline'; img-src data:; script-src https://static.cloudflareinsights.com; connect-src https://cloudflareinsights.com"
			: "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
		...(failures.length
			? { 'X-LLM-Failures': headerSafe(buildFailureSummary(failures)) }
			: {}),
	};
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
		// These free models are reasoning models. Left alone they stream a long
		// chain-of-thought as delta.reasoning before any delta.content: the page
		// looks "zombie" while the model monologues, and parsing that flood of
		// SSE lines burns real CPU against the 10ms budget. Reasoning adds
		// nothing to a site whose brand is unmedicated output — turn it off
		// where supported, and keep it out of the stream everywhere.
		reasoning: { effort: 'none', exclude: true },
	});
}

function formatFailureReason(model, reason) {
	return `${model}: ${reason}`;
}

function buildFailureSummary(failures) {
	return failures.slice(0, 4).join(' | ') || 'unknown failure';
}

function emergencyPageHtml(path, failureSummary, analytics) {
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
${analytics}
</body>
</html>`;
}

function emergencyDocsText(failureSummary) {
	return (
		`we-dont-need-no-web-dev emergency docs\n\n` +
		`The AI docs page failed to manifest, so this backup note is filling in.\n\n` +
		`How the site usually works:\n` +
		`- every request hits the Cloudflare Pages function\n` +
		`- the URL path is sent to OpenRouter\n` +
		`- a free chat model generates an entire HTML page on the fly\n` +
		`- there are no static frontend files for normal routes\n\n` +
		`What changed:\n` +
		`- models come from the openrouter/free router now, not a hardcoded list\n` +
		`  that rotted out from under the site\n` +
		`- the server runs a hedged race: one lane goes first, and another joins\n` +
		`  only if it stalls for a couple of seconds or fails\n` +
		`- timeout, rate limit, missing-model, and upstream 5xx failures open the next lane immediately\n` +
		`- if every free model fails, the server still returns a backup page instead of a raw error\n\n` +
		`Power user knobs:\n` +
		`- ?long=true doubles the token budget so pages get longer\n` +
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
		return res;
	} finally {
		clearTimeout(timeoutId);
	}
}

// One model (custom ?model=): run it directly and surface its error.
// Several models: hedged race to the first PROVEN TOKEN — see inside.
async function callLLM(
	apiKey,
	models,
	systemPrompt,
	userMessage,
	maxTokens = 4096,
	timings = {},
) {
	const firstByteMs = timings.firstByteMs || FIRST_BYTE_TIMEOUT_MS;
	const hedgeMs = timings.hedgeMs || HEDGE_MS;
	const looksUsable = timings.looksUsable || (() => true);

	if (models.length === 1) {
		const res = await fetchChatCompletion(
			apiKey,
			models[0],
			systemPrompt,
			userMessage,
			maxTokens,
		);
		if (!res.ok) {
			const errText = (await res.text()).slice(0, 240);
			const error = new Error(`LLM API error: ${res.status} — ${errText}`);
			error.status = res.status;
			error.failures = [formatFailureReason(models[0], `${res.status}`)];
			throw error;
		}
		const proven = await proveFirstToken(res, firstByteMs, looksUsable);
		if (!proven) {
			const error = new Error(
				`LLM API error: ${models[0]} opened a stream but never produced a token`,
			);
			error.status = 504;
			error.failures = [
				formatFailureReason(models[0], 'no usable output before timeout'),
			];
			throw error;
		}
		return { response: proven, model: proven.servedBy || models[0], failures: [] };
	}

	// Hedged race to the first proven token. Two hard lessons baked in:
	//
	// 1. (Vercel era) Firing every model at once burned the shared OpenRouter
	//    :free daily cap 4x — losing requests count. So lane 0 fires alone and
	//    each further lane opens after hedgeMs, or immediately when a lane
	//    fails. A healthy fast model still costs exactly one request.
	// 2. (Day one on Cloudflare) Declaring the winner on 200 headers let a
	//    zombie win: overloaded free models open the SSE socket and never emit
	//    a token, and the same model zombies consistently once overloaded. So
	//    a lane only wins by producing an actual delta token; a zombie lane
	//    burns its own proof clock without blocking anyone — later lanes race
	//    it concurrently and the first real token takes the pot.
	return new Promise((resolve) => {
		const failures = [];
		let winnerChosen = false;
		let launched = 0;
		let inFlight = 0;
		let staggerTimer = null;

		const settle = (result) => {
			if (staggerTimer) clearTimeout(staggerTimer);
			staggerTimer = null;
			resolve(result);
		};

		const launch = () => {
			staggerTimer = null;
			if (winnerChosen || launched >= models.length) return;
			const model = models[launched++];
			inFlight++;
			if (launched < models.length) {
				staggerTimer = setTimeout(launch, hedgeMs);
			}

			fetchChatCompletion(apiKey, model, systemPrompt, userMessage, maxTokens)
				.then(async (res) => {
					if (!res.ok) {
						const errText = (await res.text()).slice(0, 240);
						throw new Error(`${res.status} ${errText}`.trim());
					}
					const proven = await proveFirstToken(res, firstByteMs, looksUsable);
					if (!proven) throw new Error('no usable output before timeout');
					if (winnerChosen) {
						// Proved too late — drop the body so it stops holding one of
						// the 6 outbound connections.
						proven.body.cancel().catch(() => {});
						return;
					}
					winnerChosen = true;
					// Keep the failures accumulated so far — the X-LLM-Failures
					// header reports which lanes died on the way to the winner.
					settle({ response: proven, model: proven.servedBy || model, failures });
				})
				.catch((err) => {
					failures.push(
						formatFailureReason(
							model,
							err.name === 'AbortError' ? 'timed out' : err.message,
						),
					);
					// This lane is dead — open the next one now instead of waiting
					// out the stagger.
					if (staggerTimer) clearTimeout(staggerTimer);
					launch();
				})
				.finally(() => {
					inFlight--;
					if (!winnerChosen && inFlight === 0 && launched >= models.length) {
						settle({ response: null, model: null, failures });
					}
				});
		};

		launch();
	});
}

export async function onRequest({ request, env, waitUntil }) {
	const url = new URL(request.url);
	const path = url.pathname;

	if (path === '/favicon.ico') {
		return new Response(null, { status: 204 });
	}

	// Every crawler hit is a full LLM generation. Politely decline.
	// Previously this path fell through and served a hallucinated robots.txt as HTML.
	if (path === '/robots.txt') {
		return new Response('User-agent: *\nDisallow: /\nAllow: /$\n', {
			headers: { 'Content-Type': 'text/plain; charset=utf-8' },
		});
	}

	// Vulnerability scanners probe paths like /wp-login.php and /.env all day,
	// and each probe used to cost a full model generation. Obvious junk gets a
	// cheap static 404 — the only 404 on a site where every other path exists.
	if (SCANNER_PATHS.test(path)) {
		return new Response('404: not even the AI wants to generate this page\n', {
			status: 404,
			headers: { 'Content-Type': 'text/plain; charset=utf-8' },
		});
	}

	const analytics = analyticsScript(env.CF_BEACON_TOKEN);
	// Dashboard-tunable without a redeploy (and injectable from the tests).
	const firstByteMs = Number(env.FIRST_BYTE_TIMEOUT_MS) || FIRST_BYTE_TIMEOUT_MS;
	const hedgeMs = Number(env.HEDGE_MS) || HEDGE_MS;
	const apiKey = url.searchParams.get('key') || env.OPENROUTER_API_KEY;
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
			const { response: res, model: modelUsed, failures } = await callLLM(
				apiKey,
				customModel ? [customModel] : LANES,
				DOCS_PROMPT,
				'Explain how this website works. Be meta. Be funny.',
				4096,
				{ firstByteMs, hedgeMs, looksUsable: looksLikeProse },
			);

			if (!res) {
				const failureSummary = buildFailureSummary(failures);
				return new Response(
					`${docsHtmlPrefix('emergency-docs-fallback')}${escapeHtml(emergencyDocsText(failureSummary))}${docsHtmlSuffix(analytics)}`,
					{
						headers: {
							...htmlHeaders('emergency-docs-fallback', failures, analytics),
							'X-LLM-Fallback': 'all-models-failed',
						},
					},
				);
			}

			const { readable, writable } = new TransformStream();
			const writer = writable.getWriter();
			const encoder = new TextEncoder();

			waitUntil(
				(async () => {
					// One try around every write: a client disconnect errors the
					// writer, and any write after that must not escape into an
					// unhandled rejection. On failure, cancel the inner reader so
					// the upstream body is released rather than streamed into a
					// dead pipe.
					const reader = streamLLMResponse(res, escapeHtml).getReader();
					try {
						await writer.write(
							encoder.encode(docsHtmlPrefix(modelUsed || 'unknown')),
						);
						while (true) {
							const { done, value } = await reader.read();
							if (done) break;
							await writer.write(value);
						}
						await writer.write(encoder.encode(docsHtmlSuffix(analytics)));
						await writer.close();
					} catch {
						reader.cancel().catch(() => {});
					}
				})(),
			);

			return new Response(readable, {
				headers: htmlHeaders(modelUsed || 'unknown', failures, analytics),
			});
		}

		const models = customModel ? [customModel] : LANES;

		const cleanParams = new URLSearchParams(url.searchParams);
		cleanParams.delete('key');
		cleanParams.delete('model');
		cleanParams.delete('long');
		const cleanSearch = cleanParams.toString();

		const userMessage = `The visitor is requesting the URL path: "${path}"${
			cleanSearch ? ` with query string: "?${cleanSearch}"` : ''
		}. Generate a full HTML page for this path.`;

		const { response: res, model: modelUsed, failures } = await callLLM(
			apiKey,
			models,
			SITE_PROMPT,
			userMessage,
			useLong ? MAX_TOKENS_LONG : MAX_TOKENS,
			{ firstByteMs, hedgeMs, looksUsable: looksLikeHtml },
		);

		if (!res) {
			return new Response(
				emergencyPageHtml(path, buildFailureSummary(failures), analytics),
				{
					headers: {
						...htmlHeaders('emergency-static-fallback', failures, analytics),
						'X-LLM-Fallback': 'all-models-failed',
					},
				},
			);
		}

		// The winner arrives pre-proven: its body already contains a real token,
		// so returning here cannot flush headers for a page with no content.
		const modelMeta = `<meta name="x-model" content="${escapeHtml(modelUsed)}">`;
		const readable = streamLLMResponse(res, null, analytics, modelMeta, waitUntil);
		return new Response(readable, {
			headers: htmlHeaders(modelUsed, failures, analytics),
		});
	} catch (err) {
		const failureSummary = buildFailureSummary(err.failures || []);
		const status = err.status && err.status < 600 ? err.status : 500;

		return new Response(`Server error: ${err.message}`, {
			status,
			headers:
				failureSummary === 'unknown failure'
					? {}
					: { 'X-LLM-Failures': headerSafe(failureSummary) },
		});
	}
}
