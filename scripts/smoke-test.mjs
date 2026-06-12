// Quick smoke test of the pure-logic JSON utilities, run with:
//   npx esbuild src/llm/json-utils.ts --bundle --platform=node --format=cjs --external:obsidian --outfile=.tmp-json-utils.cjs && node scripts/smoke-test.mjs
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { extractJson, splitProposalsBlock, validateIdeas, validateModelProposals } = require("../.tmp-json-utils.cjs");

let failures = 0;
function check(name, fn) {
	try {
		fn();
		console.log(`ok   ${name}`);
	} catch (e) {
		failures++;
		console.error(`FAIL ${name}: ${e.message}`);
	}
}
function assert(cond, msg) {
	if (!cond) throw new Error(msg);
}

check("extractJson: plain JSON", () => {
	assert(extractJson('{"a":1}').a === 1, "plain object");
});
check("extractJson: fenced json with prose", () => {
	const v = extractJson('Here you go:\n```json\n[{"title":"x"}]\n```\nHope that helps!');
	assert(Array.isArray(v) && v[0].title === "x", "fenced array");
});
check("extractJson: trailing comma repair", () => {
	const v = extractJson('{"a": 1, "b": [1,2,],}');
	assert(v.b.length === 2, "repaired");
});
check("extractJson: smart quotes repair", () => {
	const v = extractJson('{“a”: “hi”}');
	assert(v.a === "hi", "smart quotes");
});
check("extractJson: JSON embedded in prose without fences", () => {
	const v = extractJson('Sure! The result is {"proposals": []} as requested.');
	assert(Array.isArray(v.proposals), "embedded");
});
check("extractJson: braces inside strings", () => {
	const v = extractJson('{"body": "use {curly} and \\"quoted\\" text", "n": 1}');
	assert(v.n === 1, "string-aware scan");
});
check("extractJson: throws on garbage", () => {
	let threw = false;
	try { extractJson("no json here at all"); } catch { threw = true; }
	assert(threw, "should throw");
});

check("splitProposalsBlock: proposals fence", () => {
	const { prose, block } = splitProposalsBlock('Done.\n```proposals\n{"proposals":[]}\n```');
	assert(prose === "Done.", "prose kept");
	assert(JSON.parse(block).proposals.length === 0, "block parsed");
});
check("splitProposalsBlock: json fence containing proposals key", () => {
	const { block } = splitProposalsBlock('text\n```json\n{"proposals":[{"id":"p1"}]}\n```');
	assert(block !== null, "detected");
});
check("splitProposalsBlock: plain prose untouched", () => {
	const { prose, block } = splitProposalsBlock("Just chatting, nothing to change.");
	assert(block === null && prose.includes("chatting"), "no block");
});
check("splitProposalsBlock: unfenced trailing JSON", () => {
	const { prose, block } = splitProposalsBlock('I merged them.\n{"proposals":[{"id":"p1","kind":"comment","number":3,"body":"x"}]}');
	assert(block !== null && prose === "I merged them.", "unfenced fallback");
});
check("splitProposalsBlock: code fence without proposals key stays prose", () => {
	const { block } = splitProposalsBlock('Example:\n```js\nconsole.log(1)\n```');
	assert(block === null, "non-proposal fence ignored");
});

check("validateIdeas: drops broken items, accepts wrapper object", () => {
	const v = validateIdeas({ ideas: [{ title: "A", summary: "s", category: "bug", sourceNote: "n.md" }, { notitle: true }] });
	assert(v.length === 1 && v[0].sourceNotes[0] === "n.md", "validated");
});
check("validateModelProposals: kind filtering and #number coercion", () => {
	const v = validateModelProposals({ proposals: [
		{ id: "new", kind: "create_issue", title: "T", body: "b", labels: ["x"] },
		{ id: "p2", kind: "comment", number: "#14", body: "hello" },
		{ id: "p3", kind: "comment", body: "missing number" },
		{ id: "p4", kind: "explode", number: 1 },
	]});
	assert(v.length === 2, `expected 2, got ${v.length}`);
	assert(v[1].number === 14, "#14 coerced");
});

process.exit(failures ? 1 : 0);
