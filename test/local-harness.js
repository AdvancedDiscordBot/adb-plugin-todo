"use strict";

/**
 * local-harness.js — offline smoke test for adb-plugin-todo.
 * Run: npm test   (node test/local-harness.js). No bot / no Mongo.
 */

const { createMockCtx } = require("./mock-ctx");
const { load } = require("../index");

let passed = 0;
let failed = 0;
function assert(cond, label) {
	if (cond) {
		console.log(`  PASS  ${label}`);
		passed++;
	} else {
		console.error(`  FAIL  ${label}`);
		failed++;
	}
}

// Minimal fake interaction. `opts` maps option-name -> value; `_sub` is the subcommand.
function fakeInteraction(_sub, opts = {}) {
	const replies = [];
	return {
		guildId: "guild-1",
		user: { id: "user-1" },
		options: {
			getSubcommand: () => _sub,
			getString: (n) => (n in opts ? opts[n] : null),
		},
		reply: async (payload) => {
			replies.push(payload);
			return payload;
		},
		replies,
	};
}

async function run() {
	console.log("\n=== adb-plugin-todo — Local Harness ===\n");

	const { ctx, registeredCommands } = createMockCtx({ pluginName: "adb-plugin-todo" });
	await load(ctx);

	assert(registeredCommands.has("todo"), "/todo registered");
	const todo = registeredCommands.get("todo");

	// add
	const add = fakeInteraction("add", { task: "buy milk" });
	await todo.execute(add);
	assert(/Added task/.test(add.replies[0].content), "add replies with new task id");
	const idMatch = add.replies[0].content.match(/`([^`]+)`/);
	const taskId = idMatch && idMatch[1];
	assert(!!taskId, "add returns a usable task id");

	// list pending -> should show the task
	const list1 = fakeInteraction("list", { filter: "pending" });
	await todo.execute(list1);
	assert(!!list1.replies[0].embeds, "list(pending) returns an embed when tasks exist");

	// done
	const done = fakeInteraction("done", { id: taskId });
	await todo.execute(done);
	assert(/Marked done/.test(done.replies[0].content), "done marks the task complete");

	// list pending -> now empty
	const list2 = fakeInteraction("list", { filter: "pending" });
	await todo.execute(list2);
	assert(/No pending tasks/.test(list2.replies[0].content), "no pending tasks after done");

	// clear -> removes the completed one
	const clear = fakeInteraction("clear");
	await todo.execute(clear);
	assert(/Cleared 1 completed/.test(clear.replies[0].content), "clear removes completed tasks");

	// edit -> persists new text via the RPC-style Model.save(doc, changes)
	const add2 = fakeInteraction("add", { task: "old text" });
	await todo.execute(add2);
	const id2 = add2.replies[0].content.match(/`([^`]+)`/)[1];
	const edit = fakeInteraction("edit", { id: id2, task: "new text" });
	await todo.execute(edit);
	assert(/Updated: new text/.test(edit.replies[0].content), "edit persists new text");
	const listAll = fakeInteraction("list", { filter: "all" });
	await todo.execute(listAll);
	assert(/new text/.test(listAll.replies[0].embeds[0].description), "edited text shows in list");

	// remove non-existent
	const rm = fakeInteraction("remove", { id: "nope" });
	await todo.execute(rm);
	assert(/No matching task/.test(rm.replies[0].content), "remove on missing id reports not found");

	// Capability gate must actually bite: a ctx built without storage denies model ops.
	{
		const { ctx: gatedCtx, registeredCommands: rc } = createMockCtx({
			pluginName: "adb-plugin-todo",
			capabilities: {}, // declare nothing
		});
		await load(gatedCtx);
		let denied = false;
		try {
			await rc.get("todo").execute(fakeInteraction("add", { task: "x" }));
		} catch (e) {
			denied = /denied/.test(e.message);
		}
		assert(denied, "storage op denied when capability not declared (gate works)");
	}

	console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
	process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
	console.error("Harness crashed:", err);
	process.exit(1);
});
