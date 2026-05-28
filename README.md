# pi-pr-alerts

A [Pi](https://github.com/earendil-works/pi) extension forked from [`pi-pr-status`](https://www.npmjs.com/package/pi-pr-status). It keeps the original footer PR status display and adds agent alerts when:

- a GitHub Actions run for the current PR fails
- status checks transition into a failed state
- a new issue comment, review, or review comment is added to the PR

## What it shows

When your current git branch has an open pull request, the footer displays:

```text
🟢 PR #42 · ✅ 5 checks passed · https://github.com/owner/repo/pull/42
```

If CI fails or comments are unresolved, it mirrors the original `pi-pr-status` footer format:

```text
🟢 PR #42 · ❌ 2/5 checks failed · 💬 3 unresolved · https://github.com/owner/repo/pull/42
```

## Agent alerts

Unlike the original extension, `pi-pr-alerts` also injects a visible custom message into the Pi session and triggers the agent when important PR activity happens:

```text
[PR alert] CI failed on PR #42: 2/5 checks failed.
[PR alert] New PR comment on #42 from octocat: Could you update this test?
```

The alert message is sent with `pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })`, so an idle agent can react immediately and a busy agent receives the alert as steering context.

## Efficient monitoring

The extension avoids brute-force CI polling where possible:

1. It discovers the PR for the current branch with `gh pr view`.
2. It starts `gh run watch <run-id> --exit-status --compact` for in-progress GitHub Actions runs, so CI failures are surfaced when the watched run exits rather than by rapidly re-querying all checks.
3. It still performs a compact 30s status refresh for footer accuracy and for non-Actions checks.
4. It probes PR comments separately with a small GraphQL query for the latest comments/reviews/review comments and skips work when the PR `updatedAt` timestamp has not changed.

## Requirements

- [Pi](https://github.com/earendil-works/pi) coding agent
- [GitHub CLI](https://cli.github.com/) (`gh`) authenticated with `gh auth login`
- A local checkout with a GitHub remote and a branch associated with a PR

## Install

From GitHub:

```bash
pi install git:github.com/nhorton/pi-pr-alerts
```

Or try it without installing:

```bash
pi -e git:github.com/nhorton/pi-pr-alerts
```

## Development

```bash
npm install
npm run check
npm run pack:dry
```

## Fork notice

This project was forked from the npm package `pi-pr-status@0.3.0` by Bruno Garcia and retains its MIT license.
