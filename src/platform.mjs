import { UnsupportedPlatformError } from './errors.mjs';

/**
 * Node platform/arch values → the names used in promptdecode release assets.
 * Anything absent from these maps is unsupported and must fail loudly.
 *
 * @type {{ os: Record<string, string>, arch: Record<string, string> }}
 */
const MAPPINGS = {
  os: { linux: 'linux', darwin: 'darwin', win32: 'windows' },
  arch: { x64: 'amd64', arm64: 'arm64' },
};

/**
 * Resolve the current (or given) platform into release-asset coordinates.
 *
 * @param {{ platform?: string, arch?: string }} [options]
 *     Defaults to `process.platform` / `process.arch`, which is what the
 *     action uses in production; overridable for tests.
 * @returns {{ os: string, arch: string, ext: string }}
 *     `os` is "linux" | "darwin" | "windows", `arch` is "amd64" | "arm64",
 *     and `ext` is ".exe" on windows, otherwise "".
 * @throws {UnsupportedPlatformError} For any platform/arch we have no binary for.
 */
export function normalizePlatform({ platform = process.platform, arch = process.arch } = {}) {
  const os = MAPPINGS.os[platform];
  if (os === undefined) {
    throw new UnsupportedPlatformError(platform, 'platform');
  }
  const mappedArch = MAPPINGS.arch[arch];
  if (mappedArch === undefined) {
    throw new UnsupportedPlatformError(arch, 'architecture');
  }
  return { os, arch: mappedArch, ext: os === 'windows' ? '.exe' : '' };
}

/**
 * Build the release asset filename for a resolved platform.
 *
 * @param {{ os: string, arch: string, ext?: string, binaryName?: string }} platform
 *     A `{ os, arch, ext }` object as returned by `normalizePlatform`.
 * @returns {string} e.g. "promptdecode-linux-amd64" or "promptdecode-windows-amd64.exe".
 */
export function assetName({ os, arch, ext = '', binaryName = 'promptdecode' }) {
  return `${binaryName}-${os}-${arch}${ext}`;
}
