# pi-pr-alerts

A [Pi](https://github.com/earendil-works/pi) extension forked from [`pi-pr-status`](https://www.npmjs.com/package/pi-pr-status). It keeps the original footer PR status display and adds agent-facing alerts for important PR activity.

## What this fork adds

Compared with the original `pi-pr-status`, this fork adds:

- **Agent alerts, not just footer status.** Important PR events are injected into the Pi session with `pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })`, so the agent can react instead of requiring the user to notice the footer.
- **CI failure alerts.** The agent is notified when a GitHub Actions run fails or when status checks transition into a failed state.
- **PR comment alerts.** The agent is notified when a new issue comment, review, or review comment is added to the PR.
- **PR merged alerts.** The agent is notified when the PR merges, with guidance to switch back to the upstream branch and update the checkout.
- **More efficient monitoring.** In-progress GitHub Actions runs are watched with `gh run watch` when possible, while comments are checked with small GraphQL probes instead of repeatedly fetching full PR details.

## What it shows

When your current git branch has an open pull request, the footer displays:

```text
🟢 repo PR - Add useful feature · ✅ 5 checks passed · ✍️ 2 uncommitted changes
```

If CI fails or comments are unresolved, it mirrors the original `pi-pr-status` footer format:

```text
🟢 repo PR - Add useful feature · ❌ 2/5 checks failed · 💬 3 unresolved · ✍️ 2 uncommitted changes
```

## Agent alerts

Unlike the original extension, `pi-pr-alerts` also injects a visible custom message into the Pi session and triggers the agent when important PR activity happens:

```text
[PR alert] CI failed on PR #42: 2/5 checks failed.
[PR alert] New PR comment on #42 from octocat: Could you update this test?
[PR alert] PR #42 just merged. You may want to switch to the upstream branch and update your code.
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
