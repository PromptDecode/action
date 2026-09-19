import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePlatform, assetName } from '../src/platform.mjs';
import { UnsupportedPlatformError } from '../src/errors.mjs';

test('every supported platform/arch pair resolves to release-asset coordinates', () => {
  const cases = [
    { platform: 'linux', arch: 'x64', os: 'linux', mapped: 'amd64', ext: '' },
    { platform: 'linux', arch: 'arm64', os: 'linux', mapped: 'arm64', ext: '' },
    { platform: 'darwin', arch: 'x64', os: 'darwin', mapped: 'amd64', ext: '' },
    { platform: 'darwin', arch: 'arm64', os: 'darwin', mapped: 'arm64', ext: '' },
    { platform: 'win32', arch: 'x64', os: 'windows', mapped: 'amd64', ext: '.exe' },
    { platform: 'win32', arch: 'arm64', os: 'windows', mapped: 'arm64', ext: '.exe' },
  ];
  for (const { platform, arch, os, mapped, ext } of cases) {
    assert.deepStrictEqual(normalizePlatform({ platform, arch }), { os, arch: mapped, ext });
  }
});

test('asset names follow promptdecode-linux-amd64 / -windows-amd64.exe shape', () => {
  assert.strictEqual(
    assetName(normalizePlatform({ platform: 'linux', arch: 'x64' })),
    'promptdecode-linux-amd64',
  );
  assert.strictEqual(
    assetName(normalizePlatform({ platform: 'darwin', arch: 'arm64' })),
    'promptdecode-darwin-arm64',
  );
  assert.strictEqual(
    assetName(normalizePlatform({ platform: 'win32', arch: 'x64' })),
    'promptdecode-windows-amd64.exe',
  );
  assert.strictEqual(
    assetName({ ...normalizePlatform({ platform: 'linux', arch: 'x64' }), binaryName: 'other-tool' }),
    'other-tool-linux-amd64',
  );
});

test('defaults come from process.platform / process.arch', () => {
  assert.deepStrictEqual(normalizePlatform(), normalizePlatform({ platform: process.platform, arch: process.arch }));
});

test('unsupported platforms throw UnsupportedPlatformError naming the value', () => {
  for (const platform of ['freebsd', 'openbsd', 'aix', 'sunos', 'android']) {
    assert.throws(() => normalizePlatform({ platform, arch: 'x64' }), (error) => {
      assert.ok(error instanceof UnsupportedPlatformError);
      assert.strictEqual(error.code, 'UNSUPPORTED_PLATFORM');
      assert.ok(error.message.includes(platform));
      return true;
    });
  }
});

test('unsupported architectures throw UnsupportedPlatformError naming the value', () => {
  for (const arch of ['ia32', 'arm', 'mips', 'ppc64', 's390x']) {
    assert.throws(() => normalizePlatform({ platform: 'linux', arch }), (error) => {
      assert.ok(error instanceof UnsupportedPlatformError);
      assert.strictEqual(error.code, 'UNSUPPORTED_PLATFORM');
      assert.ok(error.message.includes(arch));
      return true;
    });
  }
});
