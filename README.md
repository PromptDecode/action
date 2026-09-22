# promptdecode/action

The GitHub Action for [promptdecode](https://promptdeco.de): scan a repository
for text a reviewer cannot see and an agent can.

Findings become check annotations on the pull request diff, through a SARIF
upload to Code Scanning. Where that upload is unavailable — a pull request
from a fork, whose token cannot write security events — the action re-emits
every finding as a workflow-command annotation instead, so the diff is still
annotated. A run never silently produces nothing. No account, no token
exchange; the scan runs on the runner, and only the SARIF upload leaves it.

## Usage

The canonical snippet, kept in [docs/snippet.md](docs/snippet.md):

```yaml
- uses: promptdecode/action@v1
  with:
    fail-on: error
```

It assumes two things about the job it is pasted into: `actions/checkout` has
run before it, and the job holds the permission the SARIF upload needs. A
complete workflow:

```yaml
name: promptdecode

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read
  security-events: write

jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: promptdecode/action@v1
        with:
          fail-on: error
```

`security-events: write` is what turns the uploaded SARIF into check
annotations. `contents: read` covers everything else the action does and is
the right floor. On a fork pull request GitHub withholds both regardless of
this block; the action still works there. See
[Fork pull requests](#fork-pull-requests).

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `path` | `.` | Path to scan, relative to the workspace or absolute. |
| `engines` | `all` | Comma-separated engine list, passed to the scanner as `--engines`. |
| `fail-on` | `error` | Severity that fails the action: `none`, `note`, `warning` or `error`. Decided from the SARIF; the scanner's exit code never decides it. |
| `license` | (empty) | Optional promptdecode licence key, masked in the job log before first use. |

### Escape hatches

Defaults do the right thing. These exist for mirrors, air-gapped runners,
pinning, and tests.

| Input | Default | Description |
| --- | --- | --- |
| `version` | `latest` | Scanner release tag to download, or `latest`. |
| `scanner-repo` | `PromptDecode/promptdecode` | Owner/name of the repository the scanner binary is downloaded from. |
| `download-base-url` | (empty) | Replaces the whole release URL prefix (mirrors, air-gapped runners, tests); empty derives it from `scanner-repo`/`version`. |
| `checksum` | (empty) | Pinned SHA-256 of the scanner binary; authoritative when set, and it must also agree with the release manifest. |
| `scanner-path` | (empty) | Path to an already-present scanner binary; skips the download entirely. |
| `sarif-file` | `promptdecode.sarif` | Where the scanner writes its SARIF report. |
| `upload-sarif` | `auto` | `auto` or `never`; any other value fails the action. `never` skips the SARIF upload and goes straight to workflow-command annotations. |
| `token` | `${{ github.token }}` | Token used for the SARIF upload. |

## Outputs

| Output | Description |
| --- | --- |
| `sarif-file` | Path of the SARIF file the scanner produced. |
| `results-count` | Number of findings in the SARIF report. |
| `max-severity` | Highest severity among the findings: `error`, `warning`, `note`, or `none` when there are no findings. |
| `annotation-mode` | How findings were surfaced: `sarif` (uploaded; check annotations) or `workflow-commands` (the fork-PR fallback). |
| `scanner-path` | Path of the scanner binary that ran. |
| `annotations-emitted` | Number of workflow-command annotations the report step emitted; always `0` in `sarif` mode. |
| `failed` | Verdict of the run under `fail-on`: `true` when at least one finding is at or above the threshold, `false` otherwise. |

## Fork pull requests

A pull request opened from a fork gets a read-only token: whatever the
workflow's `permissions:` block says, GitHub will not grant it
`security-events: write`. The `upload-sarif` step fails with a 403, and the
findings cannot reach Code Scanning.

The action does not guess this from the event payload. It reads the upload
step's real outcome. Success means the SARIF landed, and the check annotations
come from there. Anything else means the action says so in a `::notice` and
re-emits every finding as a `::error` / `::warning` / `::notice` workflow
command with `file`, `line` and `col` properties. Workflow commands annotate
the diff like any other annotation, so a fork pull request is annotated too —
which matters, because a fork pull request is exactly where hostile content
turns up.

Two limits to know about:

- GitHub renders at most 10 annotations of each kind per step. The action
  stops at 10 per kind rather than emitting lines that would never be shown,
  and the job summary says how many were dropped.
- The complete list is always in the job summary: one row per finding —
  location, level, rule, message — in both modes, regardless of the cap.

A run never silently produces nothing. A scanner error fails the step. A
missing, empty or unparseable SARIF file fails the step. An unavailable
upload falls back to workflow commands and announces that it did.
`upload-sarif: never` selects the workflow-command path on purpose, for
workflows that do not want a Code Scanning upload at all.

## Checksum verification

Every scanner release must publish `checksums.txt`, in GNU `sha256sum` format,
beside the binaries in the same release. Verification is mandatory; there is
no flag to disable it.

- The manifest is fetched before the binary. A release with no readable
  `checksums.txt` fails the step.
- An asset missing from the manifest is a failure, not a reason to skip
  verification: nobody has attested to those bytes, so the action refuses to
  run them.
- A digest mismatch removes the downloaded file from disk and fails the step.
  No unverified binary is left behind, let alone executed.

What this buys: detection of truncated or corrupted downloads, and of an asset
swapped or edited relative to the release's own manifest. What it does not
buy: proof of who published the binary. Whoever controls the release controls
`checksums.txt` too, so a compromised release could ship both halves. The
`checksum` input closes that gap: give it a digest obtained out of band — from
the release notes you actually read, or a previous verified run — and it
becomes authoritative. It must also agree with the manifest; when the two
disagree, the action refuses before downloading the binary at all.

## `fail-on`

Severities form a ladder, and `fail-on` sets the rung the run fails at:

```
none < note < warning < error
```

`fail-on: warning` fails when a warning or anything above it is present —
errors included. `fail-on: none` never fails on findings, but it still
annotates everything and still writes the job summary. Anything other than
the four rungs is a hard failure of the step.

The action decides all of this from the SARIF report, never from the scanner's
exit code. The scanner's exit code means one thing: `0` clean, `1` findings
reported, `2` or more a scanner error that fails the step outright. Whether
findings fail the run is the action's decision, made from the report, under
your `fail-on` setting.

## Versioning

`@v1` is a moving major tag: it always points at the newest released v1.x.y
commit and is force-moved by every release, so consumers pick up fixes without
editing their workflow. How that happens, and what a tag must pass before it
moves, is in [docs/releasing.md](docs/releasing.md).

Setups that cannot tolerate a moving ref should pin `uses:` to the full commit
SHA of a release instead. (`version` pins the scanner binary's release the
same way, and `checksum` pins its exact bytes.)

## Status

The `promptdecode` scanner CLI has not been released. No release asset exists,
so the default download path has nothing to download yet, and the snippet
above does not work against a published binary today.

The action itself is implemented and its test suite is green. Its CI exercises
everything end to end with a stub scanner supplied through `scanner-path` —
the SARIF path, the fork fallback, and each rung of the `fail-on` ladder. The
same escape hatch lets you run the action today against any binary that meets
[the scanner contract](docs/cli-contract.md), which is also what the CLI's
first release will be built against.

A [Factory Zero](https://factory0.ventures) venture.
