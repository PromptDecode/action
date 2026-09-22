# The snippet

This file is the single source of truth for the snippet
[promptdeco.de](https://promptdeco.de) renders next to its Copy button.
Whoever updates the site copies the block below from here, unchanged, so the
site and the action cannot drift.

```yaml
- uses: promptdecode/action@v1
  with:
    fail-on: error
```

What it assumes about the job it is pasted into:

- `actions/checkout` has run earlier in the same job. The action scans the
  checked-out working tree.
- The job declares `permissions:` with `contents: read` and
  `security-events: write`. Without `security-events: write` — a pull request
  from a fork, for instance, where GitHub forces the token read-only — the
  action still runs and falls back to workflow-command annotations, but there
  is no Code Scanning upload.

Everything else is defaults. The full input and output list is in the
[README](../README.md).
