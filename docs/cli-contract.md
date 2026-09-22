# The scanner CLI contract

The contract between promptdecode/action and the `promptdecode` scanner CLI,
written so the CLI repository can be built against it. Everything here is
derived from the action's implementation (`action.yml`, `src/`, `bin/`).

Statements marked **[decision]** are choices this action makes: the CLI has to
match them, but nothing about them is forced by SARIF or by GitHub. Unmarked
statements are observed directly in the code.

## Release assets

The action downloads exactly two things from a release of the scanner
repository (default `PromptDecode/promptdecode`, overridable via the
`scanner-repo` input).

### The binary

One asset per supported platform, named `promptdecode-<os>-<arch>`, with
`.exe` appended on windows (`src/platform.mjs`):

| Node `platform` | Node `arch` | Asset name |
| --- | --- | --- |
| `linux` | `x64` | `promptdecode-linux-amd64` |
| `linux` | `arm64` | `promptdecode-linux-arm64` |
| `darwin` | `x64` | `promptdecode-darwin-amd64` |
| `darwin` | `arm64` | `promptdecode-darwin-arm64` |
| `win32` | `x64` | `promptdecode-windows-amd64.exe` |
| `win32` | `arm64` | `promptdecode-windows-arm64.exe` |

Any other platform or architecture fails the action. There is no fallback
asset — no tarball, no `unknown` name. The asset is the raw, self-contained
binary itself: the action makes it executable (mode `0755`, skipped on
windows) after verification and runs it directly. Nothing is unpacked.
**[decision]**

### checksums.txt

`checksums.txt` sits beside the binaries in the same release, in GNU
`sha256sum` format: `<64 hex digest>` then two spaces (text mode) or a space
and `*` (binary mode), then the asset name. One line per asset, and it must
list every platform asset. What the parser enforces (`src/checksums.mjs`):

- Blank lines and lines starting with `#` are ignored; a leading `./` on a
  name is stripped; digests are compared case-insensitively.
- A malformed line, or the same asset name listed twice, is a parse error and
  fails the step. A manifest that cannot be fully understood cannot be
  trusted.
- An asset absent from the manifest is a hard failure, never a reason to skip
  verification. An unlisted asset is an unattested asset.

### URL shapes

`src/urls.mjs` builds both URLs from `repo`, `version` and `asset`:

```
version = "latest":
  https://github.com/<repo>/releases/latest/download/<asset>
  https://github.com/<repo>/releases/latest/download/checksums.txt

version = a tag:
  https://github.com/<repo>/releases/download/<tag>/<asset>
  https://github.com/<repo>/releases/download/<tag>/checksums.txt
```

`latest` uses GitHub's latest-release shortcut URL. The `download-base-url`
action input replaces the entire prefix, so both files are fetched as
`<base>/<asset>` and `<base>/checksums.txt`; `https:` is required except on
`localhost`/`127.0.0.1`, which may use `http:` for tests.

Repo, version tag and asset name may not contain `..`; version and asset may
not contain `/`; repo must be exactly `owner/name`. These are validation rules
the action applies to its own inputs, not conventions the CLI can rely on.

## Invocation

The action invokes the binary from a `shell: bash` step (`action.yml`, "Run
the promptdecode scan" step) whose working directory is the workspace root.
The binary path and every argument are expanded from a bash array as separate
argv entries (`"$PROMPTDECODE_BIN" "${args[@]}"`), so values are not word-split,
glob-expanded, or otherwise re-parsed by the shell:

```
promptdecode --sarif <file> --path <path>
```

plus, when the corresponding action input is non-empty:

```
--engines <comma-separated list>   # the `engines` input; defaults to "all"
--license <key>                    # the `license` input
```

- `--sarif` is where the SARIF report must be written. The action creates the
  file's parent directory first, and requires the file to exist and be
  non-empty afterwards.
- `--path` is the `path` input passed through unchanged: relative to the
  workspace root, or absolute. **[decision]**
- `--engines` is optional from the action's side, but in practice always
  present, because the input defaults to `all`. What `all` means is the CLI's
  decision, not this contract's.
- `--license` is only passed when a licence was configured. What the CLI does
  with it is the CLI's business; the action's only role is masking it in the
  job log.
- stdout and stderr are never parsed for findings. The scanner may write
  human-readable progress and errors there; the `--sarif` file is the only
  output the action reads. **[decision]**

## Exit codes

```
0      clean: no findings
1      findings reported
>= 2   scanner error
```

- `0` and `1` both count as a successful scan. Whether findings then fail the
  action is decided later, from the SARIF, under the `fail-on` input. The
  scanner's exit code never decides that.
- Any exit code of 2 or more fails the action's scan step, and the code is
  re-emitted as the step's own. This includes shell-invented codes such as
  127 (binary not found).
- Independently of the exit code, the SARIF file must exist and be non-empty
  once the scanner is done. A scanner that exits 0 but writes nothing fails
  the step. **[decision]** A clean run and a crashed run must never be
  indistinguishable.

## Output: SARIF 2.1.0

The scanner writes a SARIF 2.1.0 document to the `--sarif` path. **[decision]**
The action reads a deliberate subset of it (`src/sarif.mjs`):

- The document must be valid JSON with a top-level `runs` array; anything else
  is a hard failure of the report step. Multiple entries in `runs` are all
  read. The `version` field is not checked.
- Per result, in `runs[].results[]`:

  | Field | Use |
  | --- | --- |
  | `ruleId` | Annotation title. |
  | `level` | Severity: `error`, `warning`, `note` or `none`. `note` and `none` both render as `::notice`. |
  | `message.text` | Annotation body; `message.markdown` is the fallback. |
  | `locations[0].physicalLocation.artifactLocation.uri` | File the annotation points at. |
  | `locations[0].physicalLocation.region.startLine` / `startColumn` / `endLine` / `endColumn` | Position; all optional. |

- Only `locations[0]` is read. A result with no location is still reported,
  without a file or line.
- A `level` absent from a result is taken from the rule's
  `defaultConfiguration.level`, looked up by `ruleId` across
  `tool.driver.rules` and every `tool.extensions[].rules`. A level absent in
  both places, or not one of the four known values, degrades to `warning`.
- `runs[].tool.driver.name` names the scanner in the job summary; it defaults
  to `promptdecode` when absent.
- `uriBaseId` is ignored by the action's own parsing. The Code Scanning
  convention of `uriBaseId: "%SRCROOT%"` is compatible with the upload, but
  carries no meaning here.

### The path convention: URIs are relative to the workspace root

`artifactLocation.uri` must be relative to the workspace root — the directory
GitHub Actions checks the repository out into — **not** relative to the
`--path` argument that was scanned. **[decision]** This is the one detail most
likely to be got wrong.

The action turns the URI into the `file=` of a workflow-command annotation,
and `upload-sarif` resolves it against the same root. If the CLI instead emits
paths relative to the scanned `--path`, then any run where `path` is not the
workspace root annotates the wrong files: with `path: packages/api`, a finding
in `packages/api/src/index.ts` must arrive as `packages/api/src/index.ts`, not
`src/index.ts`. Because `path` defaults to `.`, the two conventions coincide
in the simple case — which is exactly why a scanner can pass all its own
tests and still mislabel every annotation on a monorepo.

The action is tolerant of surface variation: `file://` URIs, percent-encoding,
Windows backslashes, a leading `./`, and absolute paths that live under the
workspace are all handled. None of that rescues a URI that points at the
wrong file.
