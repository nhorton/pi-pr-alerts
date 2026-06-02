import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectNewCommentAlerts, isCommentAlertable, type CommentSnapshot, type PrComment } from "../extensions/pr-status";

function comment(overrides: Partial<PrComment>): PrComment {
	return {
		id: "review-comment:1",
		author: "octocat",
		body: "please fix",
		url: "https://github.com/example/repo/pull/1#discussion_r1",
		createdAt: "2026-01-01T00:00:00Z",
		type: "review-comment",
		threadResolved: false,
		...overrides,
	};
}

function snapshot(items: PrComment[]): CommentSnapshot {
	return { updatedAt: "2026-01-01T00:00:00Z", items };
}

describe("comment alert selection", () => {
	it("alerts for review-thread comments only when the thread is unresolved", () => {
		assert.equal(isCommentAlertable(comment({ threadResolved: false })), true);
		assert.equal(isCommentAlertable(comment({ threadResolved: true })), false);
	});

	it("still alerts for top-level PR comments and reviews", () => {
		assert.equal(isCommentAlertable(comment({ type: "issue-comment", threadResolved: undefined })), true);
		assert.equal(isCommentAlertable(comment({ type: "review", threadResolved: undefined })), true);
	});

	it("uses the first snapshot as a baseline without alerting", () => {
		const seen = new Set<string>();
		const baselineComment = comment({ id: "review-comment:baseline" });

		const alerts = collectNewCommentAlerts(snapshot([baselineComment]), seen, true);

		assert.deepEqual(alerts, []);
		assert.equal(seen.has("review-comment:baseline"), true);
	});

	it("suppresses and records new comments on resolved review threads", () => {
		const seen = new Set<string>();
		const resolvedReply = comment({ id: "review-comment:resolved", threadResolved: true });

		const alerts = collectNewCommentAlerts(snapshot([resolvedReply]), seen, false);

		assert.deepEqual(alerts, []);
		assert.equal(seen.has("review-comment:resolved"), true);
	});

	it("returns new unresolved thread comments in creation order", () => {
		const seen = new Set<string>(["review-comment:seen"]);
		const newer = comment({ id: "review-comment:newer", createdAt: "2026-01-01T00:02:00Z", body: "newer" });
		const older = comment({ id: "review-comment:older", createdAt: "2026-01-01T00:01:00Z", body: "older" });
		const alreadySeen = comment({ id: "review-comment:seen", createdAt: "2026-01-01T00:00:00Z" });

		const alerts = collectNewCommentAlerts(snapshot([newer, alreadySeen, older]), seen, false);

		assert.deepEqual(alerts.map((alert) => alert.id), ["review-comment:older", "review-comment:newer"]);
	});
});
