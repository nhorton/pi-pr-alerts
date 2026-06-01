/**
 * PR Alerts Extension
 *
 * Forked from pi-pr-status. Shows PR status in the pi footer and sends agent
 * alerts when CI fails, new PR comments/review comments are added, or the PR merges.
 *
 * The extension still refreshes compact PR metadata periodically, but it avoids
 * brute-force CI polling by watching in-progress GitHub Actions runs with
 * `gh run watch` when a run is available. Comment detection uses GitHub API
 * `updatedAt`/small latest-page probes instead of repeatedly fetching the full
 * PR state.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hyperlink, Text } from "@earendil-works/pi-tui";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

interface CheckStatus {
	total: number;
	pass: number;
	fail: number;
	pending: number;
}

interface PrInfo {
	number: number;
	title: string;
	url: string;
	state: string;
	repoName: string;
	checks: CheckStatus;
	unresolvedThreads: number;
	hasMergeConflict: boolean;
}

interface RepoInfo {
	owner: string;
	name: string;
}

interface CommentSnapshot {
	updatedAt?: string;
	items: PrComment[];
}

interface PrComment {
	id: string;
	author: string;
	body: string;
	url: string;
	createdAt: string;
	type: "issue-comment" | "review-comment" | "review";
}

interface RunInfo {
	databaseId: number;
	status?: string;
	conclusion?: string;
	url?: string;
	workflowName?: string;
	displayTitle?: string;
}

function runGh(args: string[], cwd?: string, timeout = 10_000): string | undefined {
	try {
		return execFileSync("gh", args, {
			cwd,
			encoding: "utf-8",
			timeout,
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch {
		return undefined;
	}
}

function getBranch(cwd: string): string | undefined {
	try {
		return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
			cwd,
			encoding: "utf-8",
			timeout: 3000,
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch {
		return undefined;
	}
}

function getUncommittedChangeCount(cwd: string): number {
	try {
		const status = execFileSync("git", ["status", "--porcelain"], {
			cwd,
			encoding: "utf-8",
			timeout: 3000,
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		return status ? status.split("\n").length : 0;
	} catch {
		return 0;
	}
}

function getRepoInfo(cwd: string): RepoInfo | undefined {
	const json = runGh(["repo", "view", "--json", "owner,name"], cwd, 5000);
	if (!json) return undefined;
	try {
		const repo = JSON.parse(json);
		return repo.owner?.login && repo.name ? { owner: repo.owner.login, name: repo.name } : undefined;
	} catch {
		return undefined;
	}
}

function repoSlug(repo: RepoInfo): string {
	return `${repo.owner}/${repo.name}`;
}

function repoNameFromPrUrl(url: string): string {
	const match = url.match(PR_URL_RE);
	return match?.[1]?.split("/")[1] ?? "repo";
}

function hasMergeConflict(pr: Record<string, unknown>): boolean {
	return pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY";
}

function parseChecks(statusCheckRollup: unknown[]): CheckStatus {
	const checks: CheckStatus = { total: 0, pass: 0, fail: 0, pending: 0 };
	for (const check of statusCheckRollup) {
		const c = check as Record<string, string>;
		const conclusion = (c.conclusion || "").toUpperCase();
		const status = (c.status || "").toUpperCase();
		const name = c.name || "";

		if (!name && !conclusion && !status) continue;

		checks.total++;
		if (conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED") {
			checks.pass++;
		} else if (["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(conclusion)) {
			checks.fail++;
		} else if (["IN_PROGRESS", "QUEUED", "PENDING", "WAITING"].includes(status)) {
			checks.pending++;
		} else if (status === "COMPLETED") {
			checks.pass++;
		} else {
			checks.pending++;
		}
	}
	return checks;
}

const PR_URL_RE = /https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/;

function parsePrUrl(text: string): { url: string; repo: string; number: number } | null {
	const match = text.match(PR_URL_RE);
	if (!match) return null;
	return { url: match[0], repo: match[1], number: parseInt(match[2], 10) };
}

function getUnresolvedThreads(repo: RepoInfo, prNumber: number, cwd?: string): number {
	const query = `query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner, name:$name) { pullRequest(number:$number) { reviewThreads(first:100) { nodes { isResolved } } } } }`;
	const gql = runGh([
		"api",
		"graphql",
		"-f",
		`query=${query}`,
		"-F",
		`owner=${repo.owner}`,
		"-F",
		`name=${repo.name}`,
		"-F",
		`number=${prNumber}`,
	], cwd);
	if (!gql) return 0;
	try {
		const data = JSON.parse(gql);
		const threads = data?.data?.repository?.pullRequest?.reviewThreads?.nodes;
		return Array.isArray(threads) ? threads.filter((t: { isResolved: boolean }) => !t.isResolved).length : 0;
	} catch {
		return 0;
	}
}

function getPrByNumber(repo: string, prNumber: number): PrInfo | undefined {
	const json = runGh(["pr", "view", String(prNumber), "--repo", repo, "--json", "number,title,url,state,statusCheckRollup,mergeable,mergeStateStatus"]);
	if (!json) return undefined;
	try {
		const pr = JSON.parse(json);
		if (!pr.number || !pr.url) return undefined;
		const checks = Array.isArray(pr.statusCheckRollup) ? parseChecks(pr.statusCheckRollup) : { total: 0, pass: 0, fail: 0, pending: 0 };
		const [owner, name] = repo.split("/");
		return {
			number: pr.number,
			title: pr.title,
			url: pr.url,
			state: pr.state,
			repoName: name ?? repoNameFromPrUrl(pr.url),
			checks,
			unresolvedThreads: owner && name ? getUnresolvedThreads({ owner, name }, pr.number) : 0,
			hasMergeConflict: hasMergeConflict(pr),
		};
	} catch {
		return undefined;
	}
}

function getPrForBranch(cwd: string, repo?: RepoInfo): PrInfo | undefined {
	const json = runGh(["pr", "view", "--json", "number,title,url,state,statusCheckRollup,mergeable,mergeStateStatus"], cwd);
	if (!json) return undefined;
	try {
		const pr = JSON.parse(json);
		if (!pr.number || !pr.url) return undefined;
		const checks = Array.isArray(pr.statusCheckRollup) ? parseChecks(pr.statusCheckRollup) : { total: 0, pass: 0, fail: 0, pending: 0 };
		return {
			number: pr.number,
			title: pr.title,
			url: pr.url,
			state: pr.state,
			repoName: repo?.name ?? repoNameFromPrUrl(pr.url),
			checks,
			unresolvedThreads: repo ? getUnresolvedThreads(repo, pr.number, cwd) : 0,
			hasMergeConflict: hasMergeConflict(pr),
		};
	} catch {
		return undefined;
	}
}

function getPrCommentSnapshot(repo: RepoInfo, prNumber: number, cwd?: string): CommentSnapshot | undefined {
	const query = `query($owner:String!,$name:String!,$number:Int!){ repository(owner:$owner,name:$name){ pullRequest(number:$number){ updatedAt comments(last:25){nodes{id author{login} body url createdAt}} reviews(last:25){nodes{id author{login} body url createdAt}} reviewThreads(last:25){nodes{comments(last:25){nodes{id author{login} body url createdAt}}}} } } }`;
	const gql = runGh([
		"api",
		"graphql",
		"-f",
		`query=${query}`,
		"-F",
		`owner=${repo.owner}`,
		"-F",
		`name=${repo.name}`,
		"-F",
		`number=${prNumber}`,
	], cwd);
	if (!gql) return undefined;
	try {
		const pr = JSON.parse(gql)?.data?.repository?.pullRequest;
		if (!pr) return undefined;
		const items: PrComment[] = [];
		for (const node of pr.comments?.nodes ?? []) {
			items.push(normalizeComment(node, "issue-comment"));
		}
		for (const node of pr.reviews?.nodes ?? []) {
			if ((node.body ?? "").trim()) items.push(normalizeComment(node, "review"));
		}
		for (const thread of pr.reviewThreads?.nodes ?? []) {
			for (const node of thread.comments?.nodes ?? []) {
				items.push(normalizeComment(node, "review-comment"));
			}
		}
		return { updatedAt: pr.updatedAt, items };
	} catch {
		return undefined;
	}
}

function normalizeComment(node: any, type: PrComment["type"]): PrComment {
	return {
		id: `${type}:${node.id}`,
		author: node.author?.login ?? "unknown",
		body: String(node.body ?? "").trim(),
		url: node.url ?? "",
		createdAt: node.createdAt ?? "",
		type,
	};
}

function getLatestRuns(repo: RepoInfo, branch: string, cwd?: string): RunInfo[] {
	const json = runGh([
		"run",
		"list",
		"--repo",
		repoSlug(repo),
		"--branch",
		branch,
		"--limit",
		"10",
		"--json",
		"databaseId,status,conclusion,url,workflowName,displayTitle",
	], cwd);
	if (!json) return [];
	try {
		const runs = JSON.parse(json);
		return Array.isArray(runs) ? runs.filter((run) => typeof run.databaseId === "number") : [];
	} catch {
		return [];
	}
}

function formatStatus(pr: PrInfo, uncommittedChanges = 0): string {
	const stateIcon = pr.state === "MERGED" ? "🟣" : pr.state === "CLOSED" ? "🔴" : "🟢";
	const prLabel = `${pr.repoName} PR - ${pr.title}`;
	const parts: string[] = [`${stateIcon} ${hyperlink(prLabel, pr.url)}`];

	if (pr.checks.total > 0) {
		if (pr.checks.fail > 0) {
			parts.push(`❌ ${pr.checks.fail}/${pr.checks.total} checks failed`);
		} else if (pr.checks.pending > 0) {
			parts.push(`⏳ ${pr.checks.pending}/${pr.checks.total} checks pending`);
		} else {
			parts.push(`✅ ${pr.checks.total} checks passed`);
		}
	}

	if (pr.unresolvedThreads > 0) {
		parts.push(`💬 ${pr.unresolvedThreads} unresolved`);
	}

	if (pr.hasMergeConflict) {
		parts.push("⚠️ merge conflict");
	}

	if (uncommittedChanges > 0) {
		parts.push(`✍️ ${uncommittedChanges} uncommitted ${uncommittedChanges === 1 ? "change" : "changes"}`);
	}

	return parts.join(" · ");
}

function truncateBody(body: string): string {
	const oneLine = body.replace(/\s+/g, " ").trim();
	return oneLine.length > 240 ? `${oneLine.slice(0, 237)}...` : oneLine;
}

const POLL_INTERVAL = 30_000;
const COMMENT_PROBE_INTERVAL = 20_000;
const STATUS_KEY = "pr-alerts";
const MESSAGE_TYPE = "pr-alert";

export default function (pi: ExtensionAPI) {
	let statusTimer: ReturnType<typeof setInterval> | undefined;
	let commentTimer: ReturnType<typeof setInterval> | undefined;
	let lastBranch: string | undefined;
	let lastPr: PrInfo | undefined;
	let cachedRepo: RepoInfo | undefined;
	let pinnedPr: { repo: string; number: number } | null = null;
	let latestCtx: ExtensionContext | null = null;
	let seenCommentIds = new Set<string>();
	let lastPrUpdatedAt: string | undefined;
	let initialCommentBaseline = true;
	let lastFailureSignature: string | undefined;
	let lastMergeSignature: string | undefined;
	let lastConflictSignature: string | undefined;
	let watchedRunIds = new Set<number>();
	let runWatchers = new Map<number, ChildProcessWithoutNullStreams>();

	pi.registerMessageRenderer(MESSAGE_TYPE, (message, { expanded }, theme) => {
		const details = message.details as { kind?: string; url?: string; body?: string; author?: string } | undefined;
		const color = details?.kind === "ci-failure" ? "error" : "warning";
		let text = `${theme.fg(color, "[PR alert]")} ${message.content}`;
		if (expanded && details) {
			if (details.author) text += `\n${theme.fg("dim", `author: ${details.author}`)}`;
			if (details.url) text += `\n${theme.fg("dim", details.url)}`;
			if (details.body) text += `\n${details.body}`;
		}
		return new Text(text, 0, 0);
	});

	function sendAlert(content: string, details: Record<string, unknown>) {
		pi.sendMessage(
			{
				customType: MESSAGE_TYPE,
				content,
				display: true,
				details: { ...details, timestamp: Date.now() },
			},
			{ triggerTurn: true, deliverAs: "steer" },
		);
	}

	function resetAlertState() {
		seenCommentIds = new Set<string>();
		lastPrUpdatedAt = undefined;
		initialCommentBaseline = true;
		lastFailureSignature = undefined;
		lastMergeSignature = undefined;
		lastConflictSignature = undefined;
		for (const watcher of runWatchers.values()) watcher.kill();
		runWatchers = new Map();
		watchedRunIds = new Set();
	}

	function currentRepoAndPr(): { repo: RepoInfo; pr: PrInfo; repoArg: string } | undefined {
		if (!lastPr) return undefined;
		if (pinnedPr) {
			const [owner, name] = pinnedPr.repo.split("/");
			if (owner && name) return { repo: { owner, name }, pr: lastPr, repoArg: pinnedPr.repo };
		}
		if (cachedRepo) return { repo: cachedRepo, pr: lastPr, repoArg: repoSlug(cachedRepo) };
		return undefined;
	}

	function showStatus(pr: PrInfo | undefined, ui: { setStatus: (key: string, value: string | undefined) => void }, cwd?: string) {
		const previous = lastPr;
		lastPr = pr ?? undefined;
		ui.setStatus(STATUS_KEY, lastPr ? formatStatus(lastPr, cwd ? getUncommittedChangeCount(cwd) : 0) : undefined);
		maybeAlertForFailedChecks(previous, lastPr);
		maybeAlertForMerge(previous, lastPr);
		maybeAlertForMergeConflict(previous, lastPr);
	}

	function maybeAlertForFailedChecks(previous: PrInfo | undefined, current: PrInfo | undefined) {
		if (!current || current.checks.fail <= 0) return;
		const signature = `${current.url}:${current.checks.fail}/${current.checks.total}`;
		if (signature === lastFailureSignature) return;
		if (!previous || previous.url !== current.url || previous.checks.fail !== current.checks.fail || previous.checks.total !== current.checks.total) {
			lastFailureSignature = signature;
			sendAlert(`CI failed on PR #${current.number}: ${current.checks.fail}/${current.checks.total} checks failed.`, {
				kind: "ci-failure",
				url: current.url,
				pr: current.number,
				checks: current.checks,
			});
		}
	}

	function maybeAlertForMerge(previous: PrInfo | undefined, current: PrInfo | undefined) {
		if (!current || current.state !== "MERGED") return;
		const signature = current.url;
		if (signature === lastMergeSignature) return;
		if (previous?.url === current.url && previous.state !== "MERGED") {
			lastMergeSignature = signature;
			sendAlert(`PR #${current.number} just merged. You may want to switch to the upstream branch and update your code.`, {
				kind: "merge",
				url: current.url,
				pr: current.number,
			});
		}
	}

	function maybeAlertForMergeConflict(previous: PrInfo | undefined, current: PrInfo | undefined) {
		if (!current) return;
		if (current.state !== "OPEN" || !current.hasMergeConflict) {
			if (!previous || previous.url === current.url) lastConflictSignature = undefined;
			return;
		}
		const signature = current.url;
		if (signature === lastConflictSignature) return;
		if (!previous || previous.url !== current.url || !previous.hasMergeConflict) {
			lastConflictSignature = signature;
			sendAlert(`PR #${current.number} has a merge conflict with the base branch.`, {
				kind: "merge-conflict",
				url: current.url,
				pr: current.number,
			});
		}
	}

	function maybeStartRunWatchers(cwd: string) {
		if (!lastPr || !cachedRepo) return;
		const branch = getBranch(cwd);
		if (!branch || branch === "HEAD") return;
		for (const run of getLatestRuns(cachedRepo, branch, cwd)) {
			const status = (run.status ?? "").toLowerCase();
			if (!["queued", "waiting", "requested", "in_progress", "pending"].includes(status)) continue;
			if (watchedRunIds.has(run.databaseId)) continue;
			watchedRunIds.add(run.databaseId);
			const child = spawn("gh", ["run", "watch", String(run.databaseId), "--repo", repoSlug(cachedRepo), "--compact", "--exit-status", "--interval", "10"], {
				cwd,
				stdio: ["ignore", "ignore", "ignore"],
			});
			runWatchers.set(run.databaseId, child);
			child.on("exit", (code) => {
				runWatchers.delete(run.databaseId);
				if (code && code !== 0) {
					sendAlert(`GitHub Actions run failed for PR #${lastPr?.number ?? "?"}: ${run.workflowName ?? run.displayTitle ?? run.databaseId}.`, {
						kind: "ci-failure",
						url: run.url,
						runId: run.databaseId,
					});
				}
				if (latestCtx) update(latestCtx.cwd, latestCtx.ui);
			});
		}
	}

	function update(cwd: string, ui: { setStatus: (key: string, value: string | undefined) => void }) {
		const branch = getBranch(cwd);
		if (branch !== lastBranch) {
			lastBranch = branch;
			lastPr = undefined;
			resetAlertState();
		}

		if (branch && branch !== "HEAD") {
			if (!cachedRepo) cachedRepo = getRepoInfo(cwd);
			const pr = getPrForBranch(cwd, cachedRepo);
			if (pr?.state === "OPEN") {
				pinnedPr = null;
				showStatus(pr, ui, cwd);
				maybeStartRunWatchers(cwd);
				return;
			}
			if (pr?.state === "MERGED") {
				pinnedPr = null;
				showStatus(pr, ui, cwd);
				return;
			}
		}

		if (pinnedPr) {
			const pr = getPrByNumber(pinnedPr.repo, pinnedPr.number);
			showStatus(pr, ui, cwd);
			return;
		}

		showStatus(undefined, ui, cwd);
	}

	function checkComments(cwd?: string) {
		const current = currentRepoAndPr();
		if (!current || current.pr.state !== "OPEN") return;
		const snapshot = getPrCommentSnapshot(current.repo, current.pr.number, cwd);
		if (!snapshot) return;
		if (snapshot.updatedAt && snapshot.updatedAt === lastPrUpdatedAt) return;
		lastPrUpdatedAt = snapshot.updatedAt;

		const incoming = snapshot.items.filter((item) => !seenCommentIds.has(item.id));
		for (const item of snapshot.items) seenCommentIds.add(item.id);
		if (initialCommentBaseline) {
			initialCommentBaseline = false;
			return;
		}
		for (const item of incoming.sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
			sendAlert(
				`New PR comment on #${current.pr.number} from ${item.author}: ${truncateBody(item.body) || "(no body)"}\n\nIf you address this feedback, reply to the PR comment and resolve the thread/comment if appropriate.`,
				{
					kind: "comment",
					type: item.type,
					author: item.author,
					body: item.body,
					url: item.url,
					pr: current.pr.number,
				},
			);
		}
	}

	function tryPinFromUrl(text: string, ctx: ExtensionContext) {
		const parsed = parsePrUrl(text);
		if (!parsed) return;
		if (pinnedPr?.repo === parsed.repo && pinnedPr?.number === parsed.number) return;
		if (lastPr && lastPr.state === "OPEN") return;
		pinnedPr = { repo: parsed.repo, number: parsed.number };
		latestCtx = ctx;
		resetAlertState();
		showStatus(getPrByNumber(parsed.repo, parsed.number), ctx.ui, ctx.cwd);
		checkComments();
	}

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return { action: "continue" as const };
		latestCtx = ctx;
		tryPinFromUrl(event.text, ctx);
		return { action: "continue" as const };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		latestCtx = ctx;
		tryPinFromUrl(event.prompt, ctx);
	});

	pi.on("session_start", async (_event, ctx) => {
		latestCtx = ctx;
		update(ctx.cwd, ctx.ui);
		checkComments(ctx.cwd);
		statusTimer = setInterval(() => {
			if (latestCtx) update(latestCtx.cwd, latestCtx.ui);
		}, POLL_INTERVAL);
		commentTimer = setInterval(() => {
			if (latestCtx) checkComments(latestCtx.cwd);
		}, COMMENT_PROBE_INTERVAL);
	});

	pi.on("session_shutdown", async () => {
		if (statusTimer) clearInterval(statusTimer);
		if (commentTimer) clearInterval(commentTimer);
		statusTimer = undefined;
		commentTimer = undefined;
		resetAlertState();
	});
}
