import * as Y from "yjs";

const diffModule = await import("../src/sync/diff.ts");
const { applyDiffToYText } = diffModule.default ?? diffModule;

let passed = 0;
let failed = 0;

function assert(condition, name) {
	if (condition) {
		console.log(`  PASS  ${name}`);
		passed++;
	} else {
		console.error(`  FAIL  ${name}`);
		failed++;
	}
}

function applyAndCapture(oldText, newText, origin = "test-diff") {
	const doc = new Y.Doc();
	const ytext = doc.getText("content");
	ytext.insert(0, oldText);

	let delta = null;
	ytext.observe((event) => {
		delta = event.delta;
	});

	applyDiffToYText(ytext, oldText, newText, origin);

	return {
		doc,
		ytext,
		delta,
		value: ytext.toString(),
	};
}

console.log("\n--- Test 1: no-op diff is a no-op ---");
{
	const oldText = "line 1\nline 2\n";
	const { value, delta, doc } = applyAndCapture(oldText, oldText);
	assert(value === oldText, "content unchanged after no-op");
	assert(delta === null, "no transaction emitted for no-op");
	doc.destroy();
}

console.log("\n--- Test 2: small mid-document edit patches correctly ---");
{
	const oldText = "alpha\nbeta\ngamma\n";
	const newText = "alpha\nbeta updated\ngamma\n";
	const { value, delta, doc } = applyAndCapture(oldText, newText);

	assert(value === newText, "small edit produces exact final content");
	assert(Array.isArray(delta) && delta.length > 0, "small edit emits a delta");
	assert(
		delta?.some((part) => typeof part.retain === "number"),
		"small edit keeps stable surrounding content",
	);
	doc.destroy();
}

console.log("\n--- Test 3: far-apart edits stay localized on a large document ---");
{
	const lines = [];
	for (let i = 0; i < 5000; i++) {
		lines.push(`line ${String(i).padStart(4, "0")}: original content`);
	}
	const oldText = `${lines.join("\n")}\n`;

	const updated = [...lines];
	updated[49] = "line 0049: corrected intro typo";
	updated[4949] = "line 4949: appended outro paragraph";
	const newText = `${updated.join("\n")}\n`;

	const { value, delta, doc } = applyAndCapture(oldText, newText);

	assert(value === newText, "large document edit produces exact final content");
	assert(Array.isArray(delta) && delta.length >= 5, "large document delta stays segmented");
	assert(
		delta?.some((part) => typeof part.retain === "number" && part.retain > 0),
		"large document preserves unchanged anchors",
	);
	const deleted = (delta ?? []).reduce(
		(sum, part) => sum + (typeof part.delete === "number" ? part.delete : 0),
		0,
	);
	assert(deleted < oldText.length / 4, "large document does not replace a huge chunk");
	doc.destroy();
}

console.log("\n--- Test 4: line endings and trailing newline changes are preserved ---");
{
	const oldText = "first line\nsecond line";
	const newText = "first line\nsecond line\nthird line\n";
	const { value, doc } = applyAndCapture(oldText, newText);

	assert(value === newText, "trailing newline changes are preserved exactly");
	doc.destroy();
}

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"─".repeat(50)}\n`);

process.exit(failed > 0 ? 1 : 0);
