import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseUrls } from '../src/urls.mjs';
import { InvalidInputError } from '../src/errors.mjs';

const ASSET = 'promptdecode-linux-amd64';

test('latest version uses the releases/latest/download shortcut', () => {
  assert.deepStrictEqual(releaseUrls({ asset: ASSET }), {
    binaryUrl: `https://github.com/PromptDecode/promptdecode/releases/latest/download/${ASSET}`,
    checksumsUrl: 'https://github.com/PromptDecode/promptdecode/releases/latest/download/checksums.txt',
  });
});

test('pinned version sits under releases/download/<tag>', () => {
  assert.deepStrictEqual(releaseUrls({ version: 'v1.2.3', asset: ASSET }), {
    binaryUrl: `https://github.com/PromptDecode/promptdecode/releases/download/v1.2.3/${ASSET}`,
    checksumsUrl: 'https://github.com/PromptDecode/promptdecode/releases/download/v1.2.3/checksums.txt',
  });
});

test('a custom repo changes the owner/name segment', () => {
  assert.deepStrictEqual(releaseUrls({ repo: 'SomeOne/other', version: 'v0.1.0', asset: ASSET }), {
    binaryUrl: `https://github.com/SomeOne/other/releases/download/v0.1.0/${ASSET}`,
    checksumsUrl: 'https://github.com/SomeOne/other/releases/download/v0.1.0/checksums.txt',
  });
});

test('baseUrl replaces the entire github.com prefix', () => {
  assert.deepStrictEqual(
    releaseUrls({ version: 'v1.2.3', asset: ASSET, baseUrl: 'https://mirror.example.com/files' }),
    {
      binaryUrl: `https://mirror.example.com/files/${ASSET}`,
      checksumsUrl: 'https://mirror.example.com/files/checksums.txt',
    },
  );
});

test('trailing slashes on baseUrl are tolerated', () => {
  const withOne = releaseUrls({ asset: ASSET, baseUrl: 'https://mirror.example.com/files/' });
  const withMany = releaseUrls({ asset: ASSET, baseUrl: 'https://mirror.example.com/files///' });
  const expected = {
    binaryUrl: `https://mirror.example.com/files/${ASSET}`,
    checksumsUrl: 'https://mirror.example.com/files/checksums.txt',
  };
  assert.deepStrictEqual(withOne, expected);
  assert.deepStrictEqual(withMany, expected);
});

test('checksums URL always sits in the same directory as the binary', () => {
  for (const options of [
    { asset: ASSET },
    { version: 'v9.9.9', asset: ASSET },
    { asset: ASSET, baseUrl: 'https://mirror.example.com/a/b' },
  ]) {
    const { binaryUrl, checksumsUrl } = releaseUrls(options);
    assert.strictEqual(checksumsUrl, binaryUrl.replace(/[^/]+$/, 'checksums.txt'));
  }
});

test('http is allowed only for localhost and 127.0.0.1', () => {
  for (const baseUrl of ['http://localhost:8080/dist', 'http://127.0.0.1:9000']) {
    const { binaryUrl, checksumsUrl } = releaseUrls({ asset: ASSET, baseUrl });
    assert.ok(binaryUrl.startsWith(`${baseUrl.replace(/\/+$/, '')}/`));
    assert.ok(checksumsUrl.startsWith(`${baseUrl.replace(/\/+$/, '')}/`));
  }
});

test('every unsafe input is rejected with InvalidInputError', () => {
  /** @type {[string, Record<string, string>][]} */
  const rejections = [
    ['baseUrl ftp', { asset: ASSET, baseUrl: 'ftp://mirror.example.com/files' }],
    ['baseUrl plain host', { asset: ASSET, baseUrl: 'mirror.example.com/files' }],
    ['baseUrl http non-local', { asset: ASSET, baseUrl: 'http://example.com/files' }],
    ['repo without slash', { repo: 'PromptDecode', asset: ASSET }],
    ['repo with two slashes', { repo: 'a/b/c', asset: ASSET }],
    ['repo with traversal', { repo: '../etc', asset: ASSET }],
    ['version with slash', { version: 'v1/evil', asset: ASSET }],
    ['version with traversal', { version: 'v1/../../evil', asset: ASSET }],
    ['asset with slash', { asset: 'dir/promptdecode-linux-amd64' }],
    ['asset with traversal', { asset: '../promptdecode-linux-amd64' }],
    ['empty asset', { asset: '' }],
  ];
  for (const [label, options] of rejections) {
    assert.throws(() => releaseUrls(options), (error) => {
      assert.ok(error instanceof InvalidInputError, label);
      assert.strictEqual(error.code, 'INVALID_INPUT', label);
      return true;
    }, label);
  }
});
