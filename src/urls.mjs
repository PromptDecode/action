import { InvalidInputError } from './errors.mjs';

const GITHUB_RELEASE_PREFIX = 'https://github.com';
/** Hosts allowed to use plain http:, so the download tests can run a local server. */
const HTTP_ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1']);
// GitHub owner/repo names: alphanumeric, hyphen, underscore, dot. Exactly one slash.
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/**
 * Reject path-traversal-shaped input before it lands in a URL path.
 * These values come from workflow inputs and must not be able to escape
 * the /releases/download/ prefix or point somewhere else on the host.
 *
 * @param {string} name Parameter name, for the error message.
 * @param {string} value Parameter value.
 * @param {boolean} allowSlash Whether "/" is permitted (it never is for version/asset).
 */
function validateSegment(name, value, { allowSlash = false } = {}) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidInputError(`${name} must be a non-empty string.`);
  }
  if (value.includes('..')) {
    throw new InvalidInputError(`${name} "${value}" must not contain "..", which could escape the release path.`);
  }
  if (!allowSlash && value.includes('/')) {
    throw new InvalidInputError(`${name} "${value}" must not contain "/".`);
  }
}

/**
 * Validate the baseUrl override: absolute URL, https by default, http only
 * for localhost/127.0.0.1 so tests can point at a local server.
 *
 * @param {string} baseUrl
 * @returns {string} The base URL without a trailing slash.
 */
function validateBaseUrl(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new InvalidInputError(
      `baseUrl "${baseUrl}" is not an absolute URL. Use e.g. "https://mirror.example.com/files".`,
    );
  }
  const isLocal = HTTP_ALLOWED_HOSTS.has(url.hostname);
  if (url.protocol === 'http:' && !isLocal) {
    throw new InvalidInputError(
      `baseUrl "${baseUrl}" uses http:. Only https: is allowed, except on localhost/127.0.0.1 for testing.`,
    );
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new InvalidInputError(
      `baseUrl "${baseUrl}" must be an https: URL (http: is allowed only for localhost/127.0.0.1).`,
    );
  }
  return baseUrl.replace(/\/+$/, '');
}

/**
 * Build the download URLs for the promptdecode binary and its checksum manifest.
 *
 * @param {object} [options]
 * @param {string} [options.repo] "owner/name", defaults to "PromptDecode/promptdecode".
 * @param {string} [options.version] Release tag, or "latest" for the latest-release shortcut URL.
 * @param {string} options.asset Release asset filename, e.g. "promptdecode-linux-amd64".
 * @param {string} [options.baseUrl] Full prefix override; replaces the entire
 *     github.com/releases/... prefix for both URLs.
 * @returns {{ binaryUrl: string, checksumsUrl: string }}
 * @throws {InvalidInputError} On path-unsafe repo/version/asset, or a non-https baseUrl.
 */
export function releaseUrls({ repo = 'PromptDecode/promptdecode', version = 'latest', asset, baseUrl = '' } = {}) {
  validateSegment('repo', repo, { allowSlash: true });
  if (!REPO_PATTERN.test(repo)) {
    throw new InvalidInputError(`repo "${repo}" must be exactly "owner/name", e.g. "PromptDecode/promptdecode".`);
  }
  validateSegment('version', version);
  validateSegment('asset', asset);

  if (baseUrl !== '') {
    const base = validateBaseUrl(baseUrl);
    return {
      binaryUrl: `${base}/${asset}`,
      checksumsUrl: `${base}/checksums.txt`,
    };
  }

  const dir =
    version === 'latest'
      ? `${GITHUB_RELEASE_PREFIX}/${repo}/releases/latest/download`
      : `${GITHUB_RELEASE_PREFIX}/${repo}/releases/download/${version}`;
  return {
    binaryUrl: `${dir}/${asset}`,
    checksumsUrl: `${dir}/checksums.txt`,
  };
}
