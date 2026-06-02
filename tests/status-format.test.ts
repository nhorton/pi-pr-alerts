import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatLocalOnlyStatus, formatUncommittedChanges } from "../extensions/pr-status";

describe("local-only footer status", () => {
	it("hides outside a git repo", () => {
		assert.equal(formatLocalOnlyStatus(false, 3), undefined);
	});

	it("hides inside a git repo when there are no uncommitted changes", () => {
		assert.equal(formatLocalOnlyStatus(true, 0), undefined);
	});

	it("shows inside a git repo when there are uncommitted changes", () => {
		assert.equal(formatLocalOnlyStatus(true, 2), "✍️ 2 uncommitted changes");
	});

	it("uses singular wording for one uncommitted change", () => {
		assert.equal(formatUncommittedChanges(1), "✍️ 1 uncommitted change");
	});
});
