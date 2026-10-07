import test from 'node:test';
import assert from 'node:assert/strict';
import { POST } from '../api/decode/route.ts';

function upload() {
  return new Request('http://localhost/api/decode', {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': '4',
      'x-kidneyquant-file-extension': '.nd2',
      accept: 'application/vnd.kidneyquant.samples+gzip',
    },
    body: 'test',
  });
}

test('companion proxy streams uploads with Workerd-compatible redirect handling', async (t) => {
  const oldUrl = process.env.ANALYSIS_SERVICE_URL;
  const oldHosted = process.env.SELF_HOSTED;
  process.env.ANALYSIS_SERVICE_URL = 'http://127.0.0.1:8000';
  delete process.env.SELF_HOSTED;
  t.after(() => {
    if (oldUrl === undefined) delete process.env.ANALYSIS_SERVICE_URL;
    else process.env.ANALYSIS_SERVICE_URL = oldUrl;
    if (oldHosted === undefined) delete process.env.SELF_HOSTED;
    else process.env.SELF_HOSTED = oldHosted;
  });

  await t.test('streams successful data without following redirects', async (t) => {
    t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
      assert.equal(url, 'http://127.0.0.1:8000/decode');
      assert.equal(init.redirect, 'manual');
      assert.equal(await new Response(init.body).text(), 'test');
      return new Response('pixels', { headers: { 'content-type': 'application/vnd.kidneyquant.samples+gzip' } });
    });
    const response = await POST(upload());
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'pixels');
  });

  await t.test('rejects a companion redirect without forwarding its Location', async (t) => {
    let cancelled = false;
    const mock = t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      status: 307, headers: { location: 'https://other.example/decode' },
    }));
    const response = await POST(upload());
    assert.equal(response.status, 502);
    assert.equal(mock.mock.callCount(), 1);
    assert.equal(response.headers.get('location'), null);
    assert.equal(cancelled, true);
    assert.match(((await response.json()) as { error: string }).error, /redirect/);
  });

  await t.test('preserves decoder validation errors', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ detail: 'Invalid ND2 file' }, { status: 422 }));
    const response = await POST(upload());
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { detail: 'Invalid ND2 file' });
  });
});
