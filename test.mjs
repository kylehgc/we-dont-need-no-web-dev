// Smoke test for the Cloudflare Pages function. No framework, no deps.
//   node test.mjs
//
// Stubs global fetch with a fake OpenRouter SSE stream so the streaming,
// injection, and fallback paths run without a network call or an API key.
import assert from 'node:assert';

const MODULE = './functions/[[path]].js';

function sseStream(chunks) {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const c of chunks) {
				controller.enqueue(
					encoder.encode(
						`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n`,
					),
				);
			}
			controller.enqueue(encoder.encode('data: [DONE]\n'));
			controller.close();
		},
	});
}

function stubFetch(chunks, { ok = true, status = 200 } = {}) {
	globalThis.fetch = async () =>
		new Response(ok ? sseStream(chunks) : 'nope', { status });
}

// Recording stub: captures every request (auth, model, messages) and lets each
// call succeed or fail independently. `plan` maps call index -> {ok, chunks}.
function recordingFetch(plan) {
	const calls = [];
	globalThis.fetch = async (url, opts) => {
		const body = JSON.parse(opts.body);
		calls.push({ auth: opts.headers.Authorization, body });
		const step = plan[Math.min(calls.length - 1, plan.length - 1)];
		return new Response(step.ok ? sseStream(step.chunks) : 'nope', {
			status: step.ok ? 200 : step.status || 429,
		});
	};
	return calls;
}

function ctx(url, env = {}) {
	const pending = [];
	return {
		request: new Request(url),
		env,
		waitUntil: (p) => pending.push(p),
		pending,
	};
}

const KEY = { OPENROUTER_API_KEY: 'sk-or-v1-test' };
const results = [];
async function check(name, fn) {
	try {
		await fn();
		results.push(`ok   ${name}`);
	} catch (err) {
		results.push(`FAIL ${name}\n     ${err.message}`);
		process.exitCode = 1;
	}
}

const { onRequest } = await import(MODULE);

await check('robots.txt is served directly, not hallucinated', async () => {
	const res = await onRequest(ctx('https://x.dev/robots.txt', KEY));
	assert.match(res.headers.get('content-type'), /text\/plain/);
	assert.match(await res.text(), /^User-agent: \*\nDisallow: \//);
});

await check('favicon short-circuits with 204', async () => {
	const res = await onRequest(ctx('https://x.dev/favicon.ico', KEY));
	assert.strictEqual(res.status, 204);
});

await check('missing key reads env, not process.env', async () => {
	process.env.OPENROUTER_API_KEY = 'should-be-ignored';
	const res = await onRequest(ctx('https://x.dev/', {}));
	delete process.env.OPENROUTER_API_KEY;
	assert.strictEqual(res.status, 500);
	assert.match(await res.text(), /not configured/);
});

await check('page streams, injects model meta into <head>', async () => {
	stubFetch(['<!DOCTYPE html><html><head>', '<title>hi</title></head>', '<body>yo</body></html>']);
	const c = ctx('https://x.dev/ceo/of/sandwiches', KEY);
	const res = await onRequest(c);
	const html = await res.text();
	await Promise.all(c.pending);
	// Must be a real model id, not the 'unknown' fallback — guards the
	// model-name plumbing between callLLM and the response.
	const model = res.headers.get('X-Model');
	assert.ok(model && model !== 'unknown', `bad X-Model: ${model}`);
	assert.match(html, new RegExp(`<meta name="x-model" content="${model}"></head>`));
	assert.match(html, /<body>yo<\/body>/);
});

await check('docs reports the real model, not "unknown"', async () => {
	stubFetch(['hi']);
	const c = ctx('https://x.dev/docs/', KEY);
	const res = await onRequest(c);
	const html = await res.text();
	await Promise.all(c.pending);
	const model = res.headers.get('X-Model');
	assert.ok(model && model !== 'unknown', `bad X-Model: ${model}`);
	assert.match(html, new RegExp(`<meta name="x-model" content="${model}">`));
});

await check('no beacon token means no script tag at all', async () => {
	stubFetch(['<!DOCTYPE html><html><head></head><body>x</body></html>']);
	const c = ctx('https://x.dev/', KEY);
	const html = await (await onRequest(c)).text();
	await Promise.all(c.pending);
	assert.ok(!html.includes('<script'), 'expected zero script tags');
});

await check('beacon token is injected before </body>', async () => {
	stubFetch(['<!DOCTYPE html><html><head></head><body>x</body></html>']);
	const c = ctx('https://x.dev/', { ...KEY, CF_BEACON_TOKEN: 'tok123' });
	const html = await (await onRequest(c)).text();
	await Promise.all(c.pending);
	assert.match(html, /cloudflareinsights\.com\/beacon\.min\.js/);
	assert.match(html, /"token":"tok123"/);
	assert.ok(
		html.indexOf('<script') < html.indexOf('</body>'),
		'beacon must land before </body>',
	);
});

await check('docs page streams inside its shell', async () => {
	stubFetch(['i am a docs page ', 'having a crisis']);
	const c = ctx('https://x.dev/docs/', KEY);
	const html = await (await onRequest(c)).text();
	await Promise.all(c.pending);
	assert.match(html, /cat \/docs\/how-this-works\.txt/);
	assert.match(html, /i am a docs page having a crisis/);
	assert.match(html, /<span class="cursor"><\/span><\/pre>/);
});

await check('response is held until the first token arrives', async () => {
	// Stream that emits nothing until we say so, mimicking a model that takes
	// seconds to produce its first token.
	let release;
	const gate = new Promise((r) => {
		release = r;
	});
	const encoder = new TextEncoder();
	globalThis.fetch = async () =>
		new Response(
			new ReadableStream({
				async start(controller) {
					await gate;
					const payload = { choices: [{ delta: { content: '<html><head></head><body>late</body></html>' } }] };
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n`));
					controller.enqueue(encoder.encode('data: [DONE]\n'));
					controller.close();
				},
			}),
		);

	const c = ctx('https://x.dev/slow', KEY);
	let resolved = false;
	const pending = onRequest(c).then((r) => {
		resolved = true;
		return r;
	});

	// Give it a generous window to resolve early if the guard is gone.
	await new Promise((r) => setTimeout(r, 50));
	assert.strictEqual(
		resolved,
		false,
		'onRequest resolved before any body byte — browser would paint blank',
	);

	release();
	const html = await (await pending).text();
	await Promise.all(c.pending);
	assert.match(html, /<body>late<\/body>/);
});

await check('all models failing serves the emergency page', async () => {
	stubFetch([], { ok: false, status: 429 });
	const c = ctx('https://x.dev/anything', KEY);
	const res = await onRequest(c);
	assert.strictEqual(res.headers.get('X-Model'), 'emergency-static-fallback');
	assert.match(await res.text(), /LLM OUTAGE/);
});

const PAGE = ['<!DOCTYPE html><html><head></head><body>ok</body></html>'];

await check('healthy first model costs exactly one request', async () => {
	const calls = recordingFetch([{ ok: true, chunks: PAGE }]);
	const c = ctx('https://x.dev/quota-check', KEY);
	await (await onRequest(c)).text();
	await Promise.all(c.pending);
	assert.strictEqual(calls.length, 1, `hedge regressed: ${calls.length} requests for one page view`);
});

await check('failed lane opens the next immediately, reports the loser', async () => {
	const t0 = Date.now();
	const calls = recordingFetch([
		{ ok: false, status: 429 },
		{ ok: true, chunks: PAGE },
	]);
	const c = ctx('https://x.dev/failover', KEY);
	const res = await onRequest(c);
	await res.text();
	await Promise.all(c.pending);
	assert.strictEqual(calls.length, 2);
	assert.strictEqual(res.headers.get('X-Model'), calls[1].body.model);
	assert.match(res.headers.get('X-LLM-Failures'), /429/);
	assert.ok(Date.now() - t0 < 1500, 'failover waited for the stagger timer instead of advancing on failure');
});

await check('?model= failure surfaces upstream status, no fallback', async () => {
	const calls = recordingFetch([{ ok: false, status: 418 }]);
	const c = ctx('https://x.dev/x?model=someone/weird-model', KEY);
	const res = await onRequest(c);
	assert.strictEqual(calls.length, 1, 'custom model must not fall back to the free chain');
	assert.strictEqual(calls[0].body.model, 'someone/weird-model');
	assert.strictEqual(res.status, 418);
	assert.match(await res.text(), /Server error/);
});

await check('?key= authenticates and is stripped from the prompt; ?long= raises the budget', async () => {
	const calls = recordingFetch([{ ok: true, chunks: PAGE }]);
	const c = ctx('https://x.dev/some/page?key=sk-or-v1-visitor&long=true&vibe=maximal', {});
	await (await onRequest(c)).text();
	await Promise.all(c.pending);
	assert.strictEqual(calls[0].auth, 'Bearer sk-or-v1-visitor');
	assert.deepStrictEqual(
		calls[0].body.reasoning,
		{ effort: 'none', exclude: true },
		'reasoning must be disabled and excluded — reasoning floods caused the zombie/CPU incidents',
	);
	assert.strictEqual(calls[0].body.model, 'openrouter/free', 'lanes must use the self-maintaining router');
	assert.strictEqual(calls[0].body.max_tokens, 16384, '?long=true should raise the token budget');
	const userMsg = calls[0].body.messages[1].content;
	assert.ok(!userMsg.includes('sk-or-v1'), 'key leaked into the prompt');
	assert.ok(!userMsg.includes('long=true'), 'long= leaked into the prompt');
	assert.match(userMsg, /vibe=maximal/);
});

await check('truncated page gets its tags closed', async () => {
	// Model runs out of budget mid-document: no </html> ever arrives.
	stubFetch(['<!DOCTYPE html><html><head></head><body><div>cut off mid-']);
	const c = ctx('https://x.dev/truncated', KEY);
	const html = await (await onRequest(c)).text();
	await Promise.all(c.pending);
	assert.match(html, /cut off mid-/, 'partial content must survive');
	assert.match(html, /<\/body><\/html>$/, 'server must close the document');
	assert.match(html, /ran out of budget/);
});

await check('complete page is not double-closed', async () => {
	stubFetch(['<!DOCTYPE html><html><head></head><body>fine</body></html>']);
	const c = ctx('https://x.dev/complete', KEY);
	const html = await (await onRequest(c)).text();
	await Promise.all(c.pending);
	assert.strictEqual(html.match(/<\/html>/g).length, 1, 'closing tag added to an already-closed page');
	assert.ok(!html.includes('ran out of budget'));
});

await check('real model slug is reported, not the router alias', async () => {
	const encoder = new TextEncoder();
	globalThis.fetch = async () =>
		new Response(
			new ReadableStream({
				start(controller) {
					const payload = {
						model: 'google/gemma-4-31b-it:free',
						choices: [{ delta: { content: '<html><head></head><body>hi</body></html>' } }],
					};
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n`));
					controller.enqueue(encoder.encode('data: [DONE]\n'));
					controller.close();
				},
			}),
		);
	const c = ctx('https://x.dev/whodunnit', KEY);
	const res = await onRequest(c);
	const html = await res.text();
	await Promise.all(c.pending);
	assert.strictEqual(res.headers.get('X-Model'), 'google/gemma-4-31b-it:free');
	assert.match(html, /content="google\/gemma-4-31b-it:free"/);
});

await check('docs output is HTML-escaped against a hostile model', async () => {
	stubFetch(['<script>alert(1)</script>', ' & "quotes"']);
	const c = ctx('https://x.dev/docs/', KEY);
	const html = await (await onRequest(c)).text();
	await Promise.all(c.pending);
	assert.ok(!html.includes('<script>alert'), 'raw script tag reached the page');
	assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
	assert.match(html, /&amp; &quot;quotes&quot;/);
});

await check('malformed SSE lines are skipped, valid ones still stream', async () => {
	const encoder = new TextEncoder();
	globalThis.fetch = async () =>
		new Response(
			new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode('data: {not json}\n'));
					controller.enqueue(encoder.encode(': keep-alive comment\n'));
					// A reasoning delta must count as neither output nor proof.
					controller.enqueue(
						encoder.encode(
							`data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'SHOULD-NOT-APPEAR' } }] })}\n`,
						),
					);
					const payload = { choices: [{ delta: { content: '<html><head></head><body>survived</body></html>' } }] };
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n`));
					controller.enqueue(encoder.encode('data: [DONE]\n'));
					controller.close();
				},
			}),
		);
	const c = ctx('https://x.dev/messy', KEY);
	const html = await (await onRequest(c)).text();
	await Promise.all(c.pending);
	assert.match(html, /<body>survived<\/body>/);
	assert.ok(!html.includes('SHOULD-NOT-APPEAR'), 'reasoning delta leaked into the page');
});

await check('[DONE] ends the response even if the provider never closes the socket', async () => {
	const encoder = new TextEncoder();
	globalThis.fetch = async () =>
		new Response(
			new ReadableStream({
				start(controller) {
					const payload = { choices: [{ delta: { content: '<html><head></head><body>done</body></html>' } }] };
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n`));
					controller.enqueue(encoder.encode('data: [DONE]\n'));
					// Deliberately never close() — a lingering provider socket.
				},
			}),
		);
	const c = ctx('https://x.dev/lingering', KEY);
	const html = await Promise.race([
		(await onRequest(c)).text(),
		new Promise((_, rej) => setTimeout(() => rej(new Error('response never ended after [DONE]')), 3000)),
	]);
	assert.match(html, /<body>done<\/body>/);
});

await check('final token without trailing newline is not dropped', async () => {
	const encoder = new TextEncoder();
	const payload = { choices: [{ delta: { content: '<html><head></head><body>tail</body></html>' } }] };
	globalThis.fetch = async () =>
		new Response(
			new ReadableStream({
				start(controller) {
					// No trailing \n and no [DONE] — stream just ends mid-line.
					controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}`));
					controller.close();
				},
			}),
		);
	const c = ctx('https://x.dev/no-newline', KEY);
	const html = await (await onRequest(c)).text();
	await Promise.all(c.pending);
	assert.match(html, /<body>tail<\/body>/);
});

await check('all models tokenless: every lane gets one shot, then emergency page', async () => {
	let fetches = 0;
	globalThis.fetch = async () => {
		fetches++;
		return new Response(sseStream([]), { status: 200 }); // 200, closes with no tokens
	};
	const c = ctx('https://x.dev/empty-win', KEY);
	const res = await onRequest(c);
	assert.strictEqual(res.headers.get('X-LLM-Fallback'), 'all-models-failed');
	assert.match(res.headers.get('X-LLM-Failures'), /no output before timeout/);
	assert.match(await res.text(), /LLM OUTAGE/);
	assert.strictEqual(fetches, 3, 'every lane should get one shot at a zombie-only outage');
});

await check('a zombie lane cannot win the race — first proven token takes it', async () => {
	// Lane 1 opens an SSE socket, sends only keep-alives, never a token — the
	// exact production failure. Lane 2 serves a real page. The winner must be
	// lane 2, decided by proven token rather than headers, in ~hedgeMs.
	let call = 0;
	const encoder = new TextEncoder();
	globalThis.fetch = async () => {
		call++;
		if (call === 1) {
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(encoder.encode(': OPENROUTER PROCESSING\n'));
						// ...and then silence, forever.
					},
				}),
				{ status: 200 },
			);
		}
		return new Response(sseStream(PAGE), { status: 200 });
	};
	const t0 = Date.now();
	const c = ctx('https://x.dev/zombie', {
		...KEY,
		FIRST_BYTE_TIMEOUT_MS: '400',
		HEDGE_MS: '50',
	});
	const res = await onRequest(c);
	const html = await res.text();
	await Promise.all(c.pending).catch(() => {});
	assert.strictEqual(res.headers.get('X-LLM-Fallback'), null, 'should not be a fallback page');
	assert.match(html, /<body>ok<\/body>/);
	assert.strictEqual(call, 2);
	assert.ok(
		Date.now() - t0 < 350,
		'winner should be decided by the hedge, not by waiting out the zombie clock',
	);
});

await check('custom ?model= zombie surfaces 504, does not hang', async () => {
	globalThis.fetch = async () =>
		new Response(sseStream([]), { status: 200 }); // tokenless close
	const res = await onRequest(
		ctx('https://x.dev/x?model=zombie/model', { ...KEY, FIRST_BYTE_TIMEOUT_MS: '200' }),
	);
	assert.strictEqual(res.status, 504);
	assert.match(await res.text(), /never produced a token/);
});

await check('scanner probes get a cheap 404 and never touch the model', async () => {
	let fetches = 0;
	globalThis.fetch = async () => {
		fetches++;
		return new Response(sseStream(PAGE), { status: 200 });
	};
	for (const p of ['/wp-login.php', '/.env', '/xmlrpc.php', '/config.yml', '/.git/config', '/sitemap.xml']) {
		const res = await onRequest(ctx('https://x.dev' + p, KEY));
		assert.strictEqual(res.status, 404, p + ' should 404');
	}
	assert.strictEqual(fetches, 0, 'a scanner probe reached OpenRouter');
	// And absurd legit paths still generate:
	const res = await onRequest(ctx('https://x.dev/ceo/of/sandwiches', KEY));
	assert.strictEqual(res.status, 200);
});

await check('CSP blocks scripts by default, allows only the beacon when analytics is on', async () => {
	stubFetch(PAGE);
	let c = ctx('https://x.dev/', KEY);
	let res = await onRequest(c);
	await res.text();
	await Promise.all(c.pending);
	let csp = res.headers.get('Content-Security-Policy');
	assert.match(csp, /default-src 'none'/);
	assert.ok(!csp.includes('script-src'), 'no analytics -> no script source at all');

	stubFetch(PAGE);
	c = ctx('https://x.dev/', { ...KEY, CF_BEACON_TOKEN: 'tok' });
	res = await onRequest(c);
	await res.text();
	await Promise.all(c.pending);
	csp = res.headers.get('Content-Security-Policy');
	assert.match(csp, /script-src https:\/\/static\.cloudflareinsights\.com/);
});

await check('hostile ?model= cannot crash header assembly', async () => {
	recordingFetch([{ ok: false, status: 400 }]);
	const evil = encodeURIComponent('bad\r\nSet-Cookie: pwned=1\u{1F600}');
	const res = await onRequest(ctx(`https://x.dev/x?model=${evil}`, KEY));
	assert.ok(res.status >= 400, 'should surface an error status');
	assert.strictEqual(res.headers.get('Set-Cookie'), null, 'header injection');
	const failures = res.headers.get('X-LLM-Failures') || '';
	assert.ok(!/[\r\n]/.test(failures));
});

console.log(results.join('\n'));
console.log(process.exitCode ? '\nFAILED' : '\nall passed');
