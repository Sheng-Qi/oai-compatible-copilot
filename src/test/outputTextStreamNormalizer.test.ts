import * as assert from "assert";
import { OutputTextStreamNormalizer } from "../openai/outputTextStreamNormalizer";

suite("OutputTextStreamNormalizer", () => {
	function normalize(chunks: string[]): string {
		const normalizer = new OutputTextStreamNormalizer();
		return chunks.map((chunk) => normalizer.normalize(chunk)).join("") + normalizer.flushPending();
	}

	test("preserves incremental chunks", () => {
		assert.strictEqual(normalize(["Hello", ", ", "world", "!"]), "Hello, world!");
	});

	test("preserves repeated incremental chunks", () => {
		assert.strictEqual(normalize(["a", "a", "b"]), "aab");
	});

	test("drops an identical repeated full-text snapshot", () => {
		assert.strictEqual(normalize(["Hello!", "Hello!"]), "Hello!");
	});

	test("drops a repeated sequence of incremental chunks", () => {
		assert.strictEqual(normalize(["Hi", " there", "!", "Hi", " there", "!"]), "Hi there!");
	});

	test("preserves an incomplete replay candidate at stream end", () => {
		assert.strictEqual(normalize(["Hello", " world", "Hello"]), "Hello worldHello");
	});

	test("preserves a replay candidate that diverges", () => {
		assert.strictEqual(normalize(["Hello", " world", "Hello", " again"]), "Hello worldHello again");
	});
});
