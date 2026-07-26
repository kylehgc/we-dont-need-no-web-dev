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

await check('all models failing serves the emergency page', async () => {
	stubFetch([], { ok: false, status: 429 });
	const c = ctx('https://x.dev/anything', KEY);
	const res = await onRequest(c);
	assert.strictEqual(res.headers.get('X-Model'), 'emergency-static-fallback');
	assert.match(await res.text(), /LLM OUTAGE/);
});

console.log(results.join('\n'));
console.log(process.exitCode ? '\nFAILED' : '\nall passed');
