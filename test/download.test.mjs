import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchText, fetchToFile, downloadVerified } from '../src/download.mjs';
import { normalizePlatform, assetName } from '../src/platform.mjs';
import { DownloadError, ChecksumMissingError, ChecksumMismatchError, ChecksumPinMismatchError } from '../src/errors.mjs';

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL('../bin/download.mjs', import.meta.url));

// The "scanner binary" the test server serves. Its real sha256 goes in the manifest.
const BINARY = Buffer.from('#!/bin/sh\necho fake promptdecode scanner\n');
const TAMPERED = Buffer.concat([BINARY, Buffer.from('echo injected\n')]);
const BINARY_DIGEST = createHash('sha256').update(BINARY).digest('hex');
const ASSET = 'promptdecode-linux-amd64';
const MANIFEST = `${BINARY_DIGEST}  ${ASSET}\n`;

/**
 * Start a node:http server on 127.0.0.1 serving per-test `handler`, and
 * record every request path in `hits`. Closed via t.after even when a test
 * throws.
 *
 * @param {import('node:test').TestContext} t
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void} handler
 * @returns {Promise<{ url: string, hits: string[] }>}
 */
async function withServer(t, handler) {
  const hits = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, hits };
}

/** Temp directory under the OS temp dir, never inside the workspace. */
async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pd-download-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Handlers for the standard two-asset release: checksums.txt + the binary. */
function serveRelease(res, body, manifest = MANIFEST) {
  if (res.req.url.endsWith('/checksums.txt')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(manifest);
  } else {
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(body);
  }
}

/**
 * The reviewer's repro: serve the manifest normally, but for the binary
 * announce a Content-Length larger than the bytes actually written, then
 * close the socket mid-body. undici surfaces this as a bare
 * `TypeError: terminated` (cause `UND_ERR_SOCKET`) while streaming the body —
 * after `fetch()` has already resolved with a 2xx. The close is a graceful
 * FIN (`socket.end`) rather than a reset on purpose: an immediate RST can
 * reach the client before it has read the headers, which turns the failure
 * into an initial-fetch error instead of the mid-body one under test.
 */
function serveTruncated(req, res) {
  if (req.url.endsWith('/checksums.txt')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(MANIFEST);
    return;
  }
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': String(BINARY.length + 128), // promised, never sent
  });
  res.on('error', () => { /* the short body is the point; don't crash the test server */ });
  res.write(BINARY.subarray(0, 10)); // the 10-byte partial the reviewer saw
  res.socket.end();
}

/** Parse the `name<<delimiter` heredoc format src/github.mjs writes to GITHUB_OUTPUT. */
function parseGithubOutput(text) {
  /** @type {Record<string, string>} */
  const outputs = {};
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = /^(.+?)<<(.+)$/.exec(lines[i]);
    if (match === null) continue;
    const [, name, delimiter] = match;
    const values = [];
    i++;
    while (lines[i] !== delimiter) {
      values.push(lines[i]);
      i++;
    }
    outputs[name] = values.join('\n');
  }
  return outputs;
}

test('downloadVerified happy path: file written, digest returned, mode executable', async (t) => {
  const { url, hits } = await withServer(t, (req, res) => serveRelease(res, BINARY));
  const dir = await tempDir(t);
  const dest = join(dir, 'bin', ASSET);

  const result = await downloadVerified({
    binaryUrl: `${url}/${ASSET}`,
    checksumsUrl: `${url}/checksums.txt`,
    assetName: ASSET,
    destPath: dest,
    retries: 3,
    retryDelayMs: 0,
  });

  assert.deepStrictEqual(result, { path: dest, sha256: BINARY_DIGEST });
  assert.deepStrictEqual(hits.sort(), ['/checksums.txt', `/${ASSET}`]);
  assert.deepEqual(await readFile(dest), BINARY);
  if (process.platform !== 'win32') {
    const mode = (await stat(dest)).mode & 0o777;
    assert.strictEqual(mode, 0o755, 'the verified binary is chmod 0o755');
  }
});

test('fetchText returns the body of a 200', async (t) => {
  const { url } = await withServer(t, (req, res) => serveRelease(res, BINARY));
  assert.strictEqual(await fetchText(`${url}/checksums.txt`), MANIFEST);
});

test('fetchToFile creates missing parent directories', async (t) => {
  const { url } = await withServer(t, (req, res) => serveRelease(res, BINARY));
  const dir = await tempDir(t);
  const dest = join(dir, 'deeply', 'nested', 'dirs', ASSET);
  await fetchToFile(`${url}/${ASSET}`, dest, { retries: 0 });
  assert.deepEqual(await readFile(dest), BINARY);
});

test('a 404 fails without retrying — exactly one request', async (t) => {
  const { url, hits } = await withServer(t, (req, res) => {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('nope');
  });

  await assert.rejects(
    fetchText(`${url}/checksums.txt`, { retries: 3, retryDelayMs: 0 }),
    (error) => {
      assert.ok(error instanceof DownloadError);
      assert.strictEqual(error.status, 404);
      return true;
    },
  );
  assert.strictEqual(hits.length, 1, 'a 404 is never retried');

  // Same discipline through the whole pipeline: the missing manifest is fatal,
  // not a reason to look for the binary anywhere else.
  const dir = await tempDir(t);
  await assert.rejects(
    downloadVerified({
      binaryUrl: `${url}/${ASSET}`,
      checksumsUrl: `${url}/checksums.txt`,
      assetName: ASSET,
      destPath: join(dir, ASSET),
      retries: 3,
      retryDelayMs: 0,
    }),
    (error) => error instanceof DownloadError && error.status === 404,
  );
  assert.strictEqual(hits.length, 2, 'one request per downloadVerified call, no retries');
});

test('a 500 retries the configured number of times, then throws DownloadError', async (t) => {
  const { url, hits } = await withServer(t, (req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('boom');
  });
  const dir = await tempDir(t);

  await assert.rejects(
    downloadVerified({
      binaryUrl: `${url}/${ASSET}`,
      checksumsUrl: `${url}/checksums.txt`,
      assetName: ASSET,
      destPath: join(dir, ASSET),
      retries: 3,
      retryDelayMs: 0,
    }),
    (error) => {
      assert.ok(error instanceof DownloadError);
      assert.strictEqual(error.status, 500);
      return true;
    },
  );
  // Initial attempt + 3 retries.
  assert.strictEqual(hits.length, 4);
});

test('a transient 429 is retried and the retry succeeds', async (t) => {
  let calls = 0;
  const { url, hits } = await withServer(t, (req, res) => {
    if (req.url.endsWith('/checksums.txt')) {
      calls++;
      if (calls === 1) {
        res.writeHead(429, { 'content-type': 'text/plain' });
        res.end('slow down');
        return;
      }
    }
    serveRelease(res, BINARY);
  });
  const dir = await tempDir(t);

  const result = await downloadVerified({
    binaryUrl: `${url}/${ASSET}`,
    checksumsUrl: `${url}/checksums.txt`,
    assetName: ASSET,
    destPath: join(dir, ASSET),
    retries: 3,
    retryDelayMs: 0,
  });
  assert.strictEqual(result.sha256, BINARY_DIGEST);
  assert.strictEqual(hits.length, 3); // 429'd manifest, retried manifest, binary
});

test('a tampered binary throws ChecksumMismatchError and leaves no file on disk', async (t) => {
  // Manifest attests the REAL binary; the server serves tampered bytes.
  const { url, hits } = await withServer(t, (req, res) => serveRelease(res, TAMPERED));
  const dir = await tempDir(t);
  const dest = join(dir, ASSET);

  await assert.rejects(
    downloadVerified({
      binaryUrl: `${url}/${ASSET}`,
      checksumsUrl: `${url}/checksums.txt`,
      assetName: ASSET,
      destPath: dest,
      retries: 0,
      retryDelayMs: 0,
    }),
    (error) => {
      assert.ok(error instanceof ChecksumMismatchError);
      assert.strictEqual(error.code, 'CHECKSUM_MISMATCH');
      assert.strictEqual(error.path, dest);
      assert.strictEqual(error.expected, BINARY_DIGEST);
      assert.strictEqual(error.actual, createHash('sha256').update(TAMPERED).digest('hex'));
      return true;
    },
  );
  assert.ok(hits.includes(`/${ASSET}`), 'the binary was downloaded before verification');
  await assert.rejects(stat(dest), { code: 'ENOENT' }, 'the unverified file was unlinked');
});

test('a download interrupted mid-body throws DownloadError and leaves no partial file', async (t) => {
  const { url, hits } = await withServer(t, (req, res) => serveTruncated(req, res));
  const dir = await tempDir(t);
  const dest = join(dir, ASSET);

  await assert.rejects(
    fetchToFile(`${url}/${ASSET}`, dest, { retries: 0, retryDelayMs: 0 }),
    (error) => {
      assert.ok(error instanceof DownloadError, `expected DownloadError, got ${error.name}`);
      assert.ok(!(error instanceof TypeError), 'not the raw undici TypeError');
      assert.strictEqual(error.status, null, 'no status: the response itself was 2xx');
      assert.match(error.message, /interrupted/, `names the interruption: ${error.message}`);
      return true;
    },
  );
  assert.strictEqual(hits.length, 1, 'retries: 0 means exactly one request');
  await assert.rejects(stat(dest), { code: 'ENOENT' }, 'the partial file was removed from destPath');
});

test('an interrupted transfer is retried and a later attempt succeeds', async (t) => {
  let binaryRequests = 0;
  const { url, hits } = await withServer(t, (req, res) => {
    if (req.url.endsWith(`/${ASSET}`)) {
      binaryRequests++;
      if (binaryRequests === 1) {
        serveTruncated(req, res);
        return;
      }
    }
    serveRelease(res, BINARY);
  });
  const dir = await tempDir(t);

  const result = await downloadVerified({
    binaryUrl: `${url}/${ASSET}`,
    checksumsUrl: `${url}/checksums.txt`,
    assetName: ASSET,
    destPath: join(dir, ASSET),
    retries: 3,
    retryDelayMs: 0,
  });
  assert.strictEqual(result.sha256, BINARY_DIGEST);
  assert.strictEqual(binaryRequests, 2, 'the truncated attempt was retried, not fatal');
  assert.deepStrictEqual(await readFile(join(dir, ASSET)), BINARY);
});

test('a manifest that does not list the asset fails with ChecksumMissingError', async (t) => {
  const other = `${'a'.repeat(64)}  some-other-asset\n`;
  const { url, hits } = await withServer(t, (req, res) => serveRelease(res, BINARY, other));
  const dir = await tempDir(t);
  const dest = join(dir, ASSET);

  await assert.rejects(
    downloadVerified({
      binaryUrl: `${url}/${ASSET}`,
      checksumsUrl: `${url}/checksums.txt`,
      assetName: ASSET,
      destPath: dest,
      retries: 0,
      retryDelayMs: 0,
    }),
    (error) => {
      assert.ok(error instanceof ChecksumMissingError);
      assert.strictEqual(error.code, 'CHECKSUM_MISSING');
      assert.ok(error.message.includes(ASSET));
      return true;
    },
  );
  assert.ok(!hits.includes(`/${ASSET}`), 'the binary is never downloaded without a manifest entry');
  await assert.rejects(stat(dest), { code: 'ENOENT' });
});

test('a pinned sha256 disagreeing with the manifest fails before the binary is requested', async (t) => {
  const { url, hits } = await withServer(t, (req, res) => serveRelease(res, BINARY));
  const dir = await tempDir(t);
  const dest = join(dir, ASSET);

  await assert.rejects(
    downloadVerified({
      binaryUrl: `${url}/${ASSET}`,
      checksumsUrl: `${url}/checksums.txt`,
      assetName: ASSET,
      destPath: dest,
      expectedSha256: 'a'.repeat(64),
      retries: 0,
      retryDelayMs: 0,
    }),
    (error) => {
      // Distinct from a downloaded-bytes mismatch: nothing was hashed here,
      // so the error names the two sides for what they are — the pin the
      // user supplied, and the digest the release manifest lists.
      assert.ok(error instanceof ChecksumPinMismatchError);
      assert.strictEqual(error.code, 'CHECKSUM_PIN_MISMATCH');
      assert.strictEqual(error.path, dest);
      assert.strictEqual(error.pinned, 'a'.repeat(64));
      assert.strictEqual(error.manifest, BINARY_DIGEST);
      assert.ok(error.message.includes('pinned'), `names the pin: ${error.message}`);
      assert.ok(error.message.includes('manifest'), `names the manifest: ${error.message}`);
      return true;
    },
  );
  assert.deepStrictEqual(
    hits.filter((path) => path === `/${ASSET}`),
    [],
    'the server never saw a request for the binary',
  );
  await assert.rejects(stat(dest), { code: 'ENOENT' });
});

test('a pinned sha256 equal to the manifest entry downloads and verifies', async (t) => {
  const { url } = await withServer(t, (req, res) => serveRelease(res, BINARY));
  const dir = await tempDir(t);
  const dest = join(dir, ASSET);

  const result = await downloadVerified({
    binaryUrl: `${url}/${ASSET}`,
    checksumsUrl: `${url}/checksums.txt`,
    assetName: ASSET,
    destPath: dest,
    expectedSha256: BINARY_DIGEST.toUpperCase(), // case-insensitive pin
    retries: 0,
    retryDelayMs: 0,
  });
  assert.strictEqual(result.sha256, BINARY_DIGEST);
  assert.deepEqual(await readFile(dest), BINARY);
});

// ── bin/download.mjs end to end ─────────────────────────────────────────────

function binEnv(outputFile) {
  return { ...process.env, GITHUB_OUTPUT: outputFile };
}

test('bin/download.mjs downloads, verifies, writes step outputs, exits 0', async (t) => {
  const { url, hits } = await withServer(t, (req, res) => serveRelease(res, BINARY));
  const dir = await tempDir(t);
  const dest = join(dir, 'tools', ASSET);
  const outputFile = join(dir, 'github-output');

  // Pin --os/--arch so the asset name is deterministic on any runner.
  await execFileAsync(process.execPath, [
    BIN,
    '--dest', dest,
    '--base-url', url,
    '--os', 'linux',
    '--arch', 'x64',
    '--version', 'v1.2.3',
    '--sha256', BINARY_DIGEST,
  ], { env: binEnv(outputFile) });

  assert.deepEqual(await readFile(dest), BINARY);
  if (process.platform !== 'win32') {
    assert.strictEqual((await stat(dest)).mode & 0o777, 0o755);
  }
  const outputs = parseGithubOutput(await readFile(outputFile, 'utf8'));
  assert.strictEqual(outputs.path, dest);
  assert.strictEqual(outputs.sha256, BINARY_DIGEST);
  assert.ok(hits.includes(`/${ASSET}`));
});

test('bin/download.mjs exits 1 with a clean one-line error on a checksum mismatch', async (t) => {
  // Manifest attests the real binary; the server serves tampered bytes.
  const { url } = await withServer(t, (req, res) => serveRelease(res, TAMPERED));
  const dir = await tempDir(t);
  const dest = join(dir, ASSET);
  const outputFile = join(dir, 'github-output');

  await assert.rejects(
    execFileAsync(process.execPath, [
      BIN,
      '--dest', dest,
      '--base-url', url,
      '--os', 'linux',
      '--arch', 'x64',
    ], { env: binEnv(outputFile) }),
    (error) => {
      assert.strictEqual(error.code, 1, 'failure exit code is 1');
      const stderr = String(error.stderr);
      const lines = stderr.trim().split('\n');
      assert.strictEqual(lines.length, 1, `stderr is one line, got: ${JSON.stringify(lines)}`);
      assert.ok(stderr.includes('Checksum mismatch'), `names the failure: ${stderr}`);
      assert.ok(!/^\s+at /m.test(stderr), 'no stack trace for an expected ActionError');
      return true;
    },
  );
  await assert.rejects(stat(dest), { code: 'ENOENT' }, 'no unverified binary left behind');
});

test('bin/download.mjs exits 1 with a clean one-line error when the transfer is interrupted mid-body', async (t) => {
  const { url } = await withServer(t, (req, res) => serveTruncated(req, res));
  const dir = await tempDir(t);
  const dest = join(dir, ASSET);
  const outputFile = join(dir, 'github-output');

  await assert.rejects(
    execFileAsync(process.execPath, [
      BIN,
      '--dest', dest,
      '--base-url', url,
      '--os', 'linux',
      '--arch', 'x64',
    ], { env: binEnv(outputFile) }),
    (error) => {
      assert.strictEqual(error.code, 1, 'failure exit code is 1');
      const stderr = String(error.stderr);
      const lines = stderr.trim().split('\n');
      assert.strictEqual(lines.length, 1, `stderr is one line, got: ${JSON.stringify(lines)}`);
      assert.ok(stderr.includes('interrupted'), `names the interruption: ${stderr}`);
      assert.ok(!/^\s+at /m.test(stderr), 'no stack trace for an expected ActionError');
      return true;
    },
  );
  await assert.rejects(stat(dest), { code: 'ENOENT' }, 'no partial binary left behind');
});

test('bin/download.mjs exits 1 on an unexpected missing --dest, with a clean message', async (t) => {
  const dir = await tempDir(t);
  await assert.rejects(
    execFileAsync(process.execPath, [BIN], { env: binEnv(join(dir, 'out')) }),
    (error) => {
      assert.strictEqual(error.code, 1);
      const stderr = String(error.stderr);
      assert.strictEqual(stderr.trim().split('\n').length, 1);
      assert.ok(stderr.includes('--dest'));
      return true;
    },
  );
});

test('bin/download.mjs --help states that verification cannot be disabled', async (t) => {
  const dir = await tempDir(t);
  const { stdout } = await execFileAsync(process.execPath, [BIN, '--help'], {
    env: binEnv(join(dir, 'out')),
  });
  assert.match(stdout, /no flag to skip checksum verification/i);
  assert.match(stdout, /--dest/);
});
