import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { forwardedCompanionHeaders } from '../../lib/decode-metadata.mjs';

export const runtime = 'nodejs';

const ASSERTION_HEADER = 'x-kidneyquant-proxy-assertion';
const ASSERTION_FILE = '/run/secrets/kidneyquant-proxy-assertion';
const ASSERTION_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;
const COMPANION_EXTENSIONS = new Set(['nd2', 'jp2', 'j2k', 'jpx']);

async function hasTrustedGatewayAssertion(request: Request): Promise<boolean> {
  const presented = request.headers.get(ASSERTION_HEADER);
  const authenticatedUser = request.headers.get('x-kidneyquant-authenticated-user')?.trim();
  if (!authenticatedUser || !presented || !ASSERTION_PATTERN.test(presented)) return false;

  try {
    const expected = (await readFile(ASSERTION_FILE, 'utf8')).trim();
    if (!ASSERTION_PATTERN.test(expected)) return false;

    const expectedBytes = Buffer.from(expected, 'utf8');
    const presentedBytes = Buffer.from(presented, 'utf8');
    return expectedBytes.length === presentedBytes.length && timingSafeEqual(expectedBytes, presentedBytes);
  } catch {
    return false;
  }
}

export async function POST(request: Request) {
  const isSelfHosted = process.env.SELF_HOSTED === 'true';
  if (isSelfHosted && !(await hasTrustedGatewayAssertion(request))) {
    return Response.json(
      { error: 'This endpoint is available only through the trusted authentication gateway.' },
      { status: 403, headers: { 'cache-control': 'no-store' } },
    );
  }

  const serviceUrl = process.env.ANALYSIS_SERVICE_URL;
  if (!serviceUrl) {
    return Response.json(
      {
        error: 'JP2 and ND2 require the configured private image companion; TIFF remains browser-local.',
      },
      { status: 501, headers: { 'cache-control': 'no-store' } },
    );
  }

  const contentType = request.headers.get('content-type')?.trim().toLowerCase();
  if (contentType !== 'application/octet-stream') {
    return Response.json(
      { error: 'Upload one ND2 or JP2-family file as application/octet-stream.' },
      { status: 415, headers: { 'cache-control': 'no-store' } },
    );
  }

  const rawExtension = request.headers.get('x-kidneyquant-file-extension')?.trim().toLowerCase() ?? '';
  const extension = rawExtension.startsWith('.') ? rawExtension.slice(1) : rawExtension;
  if (!COMPANION_EXTENSIONS.has(extension)) {
    return Response.json(
      { error: 'X-KidneyQuant-File-Extension must be one of: nd2, jp2, j2k, or jpx.' },
      { status: 415, headers: { 'cache-control': 'no-store' } },
    );
  }

  const contentLengthHeader = request.headers.get('content-length');
  if (!contentLengthHeader) {
    return Response.json(
      { error: 'Content-Length is required for image uploads.' },
      { status: 411, headers: { 'cache-control': 'no-store' } },
    );
  }
  if (!/^\d+$/.test(contentLengthHeader)) {
    return Response.json(
      { error: 'Content-Length must be a non-negative integer.' },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }
  const contentLength = Number(contentLengthHeader);
  const maxUploadBytes = Number(process.env.MAX_UPLOAD_BYTES ?? 512 * 1024 * 1024);
  if (!Number.isSafeInteger(contentLength) || contentLength < 1) {
    return Response.json(
      { error: 'The upload body is empty or has an invalid length.' },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 1 || contentLength > maxUploadBytes) {
    return Response.json(
      { error: 'The file exceeds the configured companion upload limit.' },
      { status: 413, headers: { 'cache-control': 'no-store' } },
    );
  }

  if (!request.body) {
    return Response.json(
      { error: 'The upload body is empty.' },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  let response: Response;
  try {
    response = await fetch(`${serviceUrl.replace(/\/$/, '')}/decode`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'accept': request.headers.get('accept') === 'application/vnd.kidneyquant.samples+gzip'
          ? 'application/vnd.kidneyquant.samples+gzip' : 'image/png',
        'content-length': String(contentLength),
        'x-kidneyquant-file-extension': `.${extension}`,
      },
      body: request.body,
      // Workerd supports manual/follow, but rejects redirect: 'error'.
      // Inspect redirects explicitly so uploaded data never follows a new URL.
      redirect: 'manual',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(15 * 60 * 1000)]),
      // @ts-expect-error Node fetch requires duplex for a streamed request body.
      duplex: 'half',
    });
  } catch (error) {
    console.error('Companion request failed:', error);
    return Response.json(
      { error: 'The private image companion is unavailable. Try again after the service recovers.' },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }

  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    return Response.json(
      { error: 'The private image companion returned a redirect. Configure its direct service address.' },
      { status: 502, headers: { 'cache-control': 'no-store' } },
    );
  }

  return new Response(response.body, {
    status: response.status,
    headers: forwardedCompanionHeaders(response.headers),
  });
}
