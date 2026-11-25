import * as assert from "assert";
import { executeWithRetry } from "../utils";

suite("request retry", () => {
	test("does not dispatch after cancellation", async () => {
		const controller = new AbortController();
		controller.abort();
		let attempts = 0;
		await assert.rejects(executeWithRetry(async () => ++attempts, { enabled: true }, controller.signal), { name: "AbortError" });
		assert.strictEqual(attempts, 0);
	});

	test("cancellation during backoff prevents another dispatch", async () => {
		const controller = new AbortController();
		let attempts = 0;
		await assert.rejects(executeWithRetry(async () => {
			attempts++;
			setImmediate(() => controller.abort());
			throw new Error("[503]");
		}, { enabled: true, interval_ms: 1000 }, controller.signal), { name: "AbortError" });
		assert.strictEqual(attempts, 1);
	});
});