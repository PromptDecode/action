#!/usr/bin/env node
/**
 * bin/download.mjs — download the promptdecode scanner binary and verify it.
 *
 * Fail-closed by design: every path through this entry point either ends with
 * a binary whose sha256 matches the release manifest (and, when supplied, the
 * user's pinned digest) or exits 1 with nothing unverified left on disk.
 *
 * Flags match action.yml step 3 ("Download the scanner binary") plus the
 * optional overrides documented below.
 */

import { parseArgs } from '../src/args.mjs';
import { normalizePlatform, assetName } from '../src/platform.mjs';
import { releaseUrls } from '../src/urls.mjs';
import { downloadVerified } from '../src/download.mjs';
import { setOutput } from '../src/github.mjs';
import { ActionError, InvalidInputError } from '../src/errors.mjs';

const HELP = `Usage: node bin/download.mjs --dest <path> [options]

Download the promptdecode scanner binary from a GitHub release and verify its
SHA-256 against the release's checksums.txt. The step fails (exit 1) unless
the downloaded bytes match a verified digest.

Flags:
  --dest <path>           Full path the binary is written to (required). This
                          is the binary file itself, not a directory.
  --repo <owner/name>     Repository holding the release
                          (default: PromptDecode/promptdecode).
  --version <tag|latest>  Release tag, or "latest"
                          (default: latest).
  --base-url <url>        Replace the whole github.com release URL prefix,
                          for mirrors, air-gapped runners, and tests.
  --sha256 <hex>          Digest you expect the binary to have, e.g. pinned
                          from the release notes. When set, it is
                          authoritative and must also match checksums.txt.
  --binary-name <name>    Asset base name (default: promptdecode).
  --os <os>               Override platform detection (linux|darwin|win32).
  --arch <arch>           Override architecture detection (x64|arm64).
  --help                  Show this help.

There is deliberately no flag to skip checksum verification. A missing or
unreadable checksums.txt, an asset absent from the manifest, or any digest
mismatch is a hard failure: exit 1, and no unverified binary is left on disk.

Step outputs (via GITHUB_OUTPUT): path, sha256.`;

const DEFAULTS = {
  dest: '',
  repo: 'PromptDecode/promptdecode',
  version: 'latest',
  'base-url': '',
  sha256: '',
  'binary-name': 'promptdecode',
  os: '',
  arch: '',
};

async function main() {
  const args = parseArgs(process.argv.slice(2), { defaults: DEFAULTS });

  if (args.help) {
    console.log(HELP);
    return;
  }

  if (typeof args.dest !== 'string' || args.dest === '') {
    throw new InvalidInputError(
      '--dest is required: the full path (file, not directory) the verified binary is written to.',
    );
  }

  // Honour explicit --os/--arch; either may be given alone, the other falls
  // back to what the runner actually is.
  const platform = normalizePlatform({
    ...(args.os !== '' ? { platform: args.os } : {}),
    ...(args.arch !== '' ? { arch: args.arch } : {}),
  });
  const asset = assetName({ ...platform, binaryName: args['binary-name'] });
  const { binaryUrl, checksumsUrl } = releaseUrls({
    repo: args.repo,
    version: args.version,
    asset,
    baseUrl: args['base-url'],
  });

  const { path, sha256 } = await downloadVerified({
    binaryUrl,
    checksumsUrl,
    assetName: asset,
    destPath: args.dest,
    expectedSha256: args.sha256 === '' ? null : args.sha256,
  });

  setOutput('path', path);
  setOutput('sha256', sha256);

  // One line: names the asset and its verified digest, for the job log.
  console.log(
    `::notice title=Scanner binary verified::Downloaded ${asset} and verified its sha256 (${sha256}) against the release checksum manifest.`,
  );
}

main().catch((error) => {
  if (error instanceof ActionError) {
    // Expected failure (bad input, download, checksum): the message alone,
    // no stack trace, exit 1. The message is a single line by construction.
    console.error(error.message);
  } else {
    // A bug in the action itself: fail the step, but keep the stack so the
    // report is actionable.
    console.error(error);
  }
  process.exitCode = 1;
});
