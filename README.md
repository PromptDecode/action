# promptdecode/action

The GitHub Action for [promptdecode](https://promptdeco.de): scan a repository
for text a reviewer cannot see and an agent can.

**Not built yet.** `promptdecode/action@v1` does not resolve, which is why the
site shows the snippet but does not offer it for copying.

When it exists: findings arrive as check annotations via SARIF, with a
`::warning` fallback for pull requests from forks, which is exactly where
hostile content turns up. No account, no token exchange, nothing leaving the
runner.

A [Factory Zero](https://factory0.ventures) venture.