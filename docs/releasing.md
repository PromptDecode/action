# Releasing promptdecode/action

What a release is, what `@v1` means, and how
`.github/workflows/release.yml` turns a tag into one.

## The moving tag

Consumers write `uses: promptdecode/action@v1`. `v1` is not a release tag for
one version; it is a moving tag that always points at the newest released
v1.x.y commit. Cutting `v1.4.2` force-moves `v1` onto the `v1.4.2` commit, so
every consumer on `@v1` picks the release up without editing their workflow.

That movement is by design: it is how a scanner action ships fixes to everyone
at once. It also means behavior can change under a consumer on `@v1`. A
consumer who does not want that should pin something immovable — see
[Pinning](#pinning).

## How a release happens

`release.yml` runs on two triggers:

1. **Push a semver tag** `v*.*.*` (for example `v1.4.2`).
2. **`workflow_dispatch`**, naming an existing `v*.*.*` tag in the `tag`
   input — the manual path, for re-releasing a tag that already exists.

Either way, the workflow checks out the repository at that exact tag and:

- Validates the tag shape — a strict `vX.Y.Z`: three numeric components and
  nothing trailing, which also rules out pre-release suffixes (see below).
- Runs the unit tests.
- Smoke-runs the action itself against the stub scanner and asserts it finds
  the fixture findings, so the scan → SARIF → report path is proven working,
  not just unit-green.
- Force-moves the major tag: `git tag -f v1 <sha>`, then
  `git push --force origin refs/tags/v1:refs/tags/v1`.

A tag can therefore never move past a red build: both gates run at the commit
the tag names, before anything moves. Releases are serialized by a concurrency
group, so two releases cannot interleave their tag moves. The push needs
`contents: write`, which the workflow grants. This workflow is the only thing
allowed to move the major tag.

Note what a release of this action is not: it does not build or publish the
scanner binary. Scanner releases live in the scanner repository, and their
shape is specified in [cli-contract.md](cli-contract.md).

## Pre-releases never move the major tag

A tag containing `-` — `v1.0.0-rc.1`, `v2.0.0-beta.1` — is a pre-release in
semver, and the workflow refuses it outright. An unstable tag must never drag
a major tag along with it: only a stable `vX.Y.Z` moves `vX`.

## Pinning

`@v1` moves under consumers by design. A consumer who wants immovable behavior
should pin one of:

- **A full semver tag**, `promptdecode/action@v1.4.2`. Release tags are
  created once and never re-pointed by the release workflow.
- **The full commit SHA** of a release commit, for hardened setups:
  `promptdecode/action@<40-character sha>`. The release run's job summary
  prints the SHA the moving tag was moved to. This is the same discipline the
  `checksum` input applies to the scanner binary: pin the exact bytes you
  audited.

Do not confuse the action's tag with the `version` input: `version` pins which
release of the *scanner binary* is downloaded, and is unaffected by which
commit of the action runs.

## If the moving tag is wrong

If `v1` points at the wrong commit — a bad release was cut and had to be
reverted, or a release needs re-cutting — re-point it by running the release
workflow again: **Run workflow** on `release.yml`, passing the tag that should
be released. It re-runs both gates at that tag's commit and force-moves the
major tag there. That is the preferred correction, because it is gated.

The ungated fallback is to move the tag by hand, from a machine with push
rights:

```
git tag -f v1 <correct-sha>
git push --force origin refs/tags/v1:refs/tags/v1
```

This skips the gates, so check first that the SHA is a commit whose CI was
green.
