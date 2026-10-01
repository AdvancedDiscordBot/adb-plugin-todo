"use strict";

const assert = require("node:assert/strict");
const { createMockCtx, createInteraction, newId } = require("./mock-ctx");
const { load } = require("../index");
const manifest = require("../plugin.json");

let passed = 0;
let failed = 0;
async function test(name, run) {
	try {
		await run();
		passed++;
		console.log(`PASS ${name}`);
	} catch (error) {
		failed++;
		console.error(`FAIL ${name}: ${error.stack}`);
	}
}

async function fixture(mode) {
	const mock = createMockCtx({ mode });
	await load(mock.ctx);
	const command = mock.registeredCommands.get("todo");
	assert.ok(command);
	const model = mock.models.get(`plugin_${manifest.name}_todo`);
	return {
		...mock, command, model,
		async execute(sub, values, actor) {
			const interaction = createInteraction(sub, values, actor);
			await command.execute(interaction, mock.client); // Core passes client, not ctx.
			assert.equal(interaction.replies.length, 1);
			assert.equal(interaction.replies[0].ephemeral, true);
			return interaction.replies[0];
		},
		seed: (extra = {}) => model.create({ guildId: "guild-1", userId: "user-1", content: "task", ...extra }),
	};
}

async function main() {
	for (const mode of ["worker", "direct"]) {
		await test(`${mode}: registered add/edit/done/list/clear handlers persist through common model APIs`, async () => {
			const f = await fixture(mode);
			const added = await f.execute("add", { task: "buy milk" });
			const id = added.content.match(/`([^`]+)`/)[1];
			assert.match(id, /^[a-f0-9]{24}$/);
			assert.match((await f.execute("edit", { id, task: "buy bread" })).content, /Updated: buy bread/);
			assert.match((await f.execute("list")).embeds.map((e) => e.description).join(""), /buy bread/);
			assert.match((await f.execute("done", { id })).content, /Marked done/);
			assert.equal(f.model._store[0].done, true);
			assert.ok(f.model._store[0].updatedAt instanceof Date);
			assert.match((await f.execute("done", { id })).content, /already completed/);
			assert.match((await f.execute("list")).content, /No pending tasks/);
			assert.match((await f.execute("list", { filter: "done" })).embeds[0].description, /buy bread/);
			assert.match((await f.execute("clear")).content, /Cleared 1 completed/);
			assert.ok(!f.model._calls.some((call) => call.method === "save"), "no worker-only Model.save");
		});

		await test(`${mode}: maxItems comes from current guild config and counts only pending tasks`, async () => {
			const f = await fixture(mode);
			await f.ctx.db.updatePluginConfig("guild-1", manifest.name, { maxItems: 1 });
			const active = await f.seed();
			await f.seed({ done: true });
			const full = await f.execute("add", { task: "blocked" });
			assert.match(full.content, /1 pending tasks? \(max 1\)/);
			assert.match(full.content, /Complete|complete/);
			assert.match((await f.execute("add", { task: "different guild" }, { guildId: "guild-2" })).content, /Added task/);
			assert.match((await f.execute("add", { task: "different user" }, { userId: "user-2" })).content, /Added task/);
			await f.execute("done", { id: String(active._id) });
			assert.match((await f.execute("add", { task: "room after completion" })).content, /Added task/);
			await f.ctx.db.updatePluginConfig("guild-1", manifest.name, { maxItems: 2 });
			assert.match((await f.execute("add", { task: "new limit" })).content, /Added task/);
		});

		await test(`${mode}: default maxItems is 50 and completing or removing a task frees capacity`, async () => {
			const f = await fixture(mode);
			for (let i = 0; i < 50; i++) await f.seed();
			assert.match((await f.execute("add", { task: "full" })).content, /max 50/);
			await f.execute("remove", { id: f.model._store[0]._id });
			assert.match((await f.execute("add", { task: "room" })).content, /Added task/);
		});

		await test(`${mode}: edit enforces the same 1000-character boundary as add`, async () => {
			const f = await fixture(mode);
			const task = await f.seed({ content: "unchanged" });
			for (const sub of ["add", "edit"]) {
				for (const content of ["x".repeat(1001), "", "   ", null]) {
					const reply = await f.execute(sub, { id: String(task._id), task: content });
					assert.match(reply.content, /long|empty|required/i);
					assert.equal(f.model._store[0].content, "unchanged");
				}
			}
			await f.execute("edit", { id: String(task._id), task: "x".repeat(1000) });
			assert.equal(f.model._store[0].content.length, 1000);
			assert.match((await f.execute("add", { task: "x".repeat(1000) })).content, /Added task/);
		});

		await test(`${mode}: malformed IDs are handled before Mongoose casting and valid missing IDs report not found`, async () => {
			const f = await fixture(mode);
			for (const sub of ["done", "edit", "remove"]) {
				for (const id of ["nope", "123", "z".repeat(24), "f".repeat(23), null]) {
					assert.match((await f.execute(sub, { id, task: "x" })).content, /ID|found/i);
				}
			}
			assert.equal(f.model._calls.length, 0);
			for (const sub of ["done", "edit", "remove"]) assert.match((await f.execute(sub, { id: newId(), task: "x" })).content, /found/);
		});

		await test(`${mode}: mutations, lists, and clear stay scoped to the requesting guild and user`, async () => {
			const f = await fixture(mode);
			const foreign = await f.seed({ guildId: "guild-2", content: "foreign", done: true });
			const otherUser = await f.seed({ userId: "user-2", content: "other user", done: true });
			const own = await f.seed({ done: true });
			await f.seed();
			for (const id of [String(foreign._id), String(otherUser._id)]) {
				for (const sub of ["edit", "done", "remove"]) assert.match((await f.execute(sub, { id, task: "attack" })).content, /found/);
			}
			const list = (await f.execute("list", { filter: "all" })).embeds.map((e) => e.description).join("");
			assert.ok(list.includes(String(own._id)) && !list.includes("foreign") && !list.includes("other user"));
			assert.match((await f.execute("clear")).content, /Cleared 1 completed/);
			assert.equal(f.model._store.length, 3);
			assert.equal(f.model._calls.filter((call) => call.method === "deleteMany").length, 1, "clear uses the shared bulk-delete API");
		});

		await test(`${mode}: long-task pages respect description/aggregate limits without hiding task IDs`, async () => {
			const f = await fixture(mode);
			const ids = [];
			for (let i = 0; i < 12; i++) ids.unshift(String((await f.seed({ content: `${i} `.padEnd(1000, "x"), createdAt: new Date(1700000000000 + i * 1000) }))._id));
			const seen = [];
			for (let page = 1; page <= 3; page++) {
				const reply = await f.execute("list", { page, filter: "all" });
				const text = reply.embeds.map((e) => e.description).join("\n");
				assert.match(reply.embeds[reply.embeds.length - 1].footer.text, new RegExp(`Page ${page}/3`));
				for (const id of ids) if (text.includes(id)) seen.push(id);
			}
			assert.deepEqual(seen, ids);
			const calls = f.model._calls.filter((call) => call.method === "find");
			assert.equal(calls.length, 3);
			assert.ok(calls.every((call) => call.options.limit === 5 && call.returned <= 5));
			assert.deepEqual(calls.map((call) => call.options.skip || 0), [0, 5, 10]);
		});

		await test(`${mode}: task IDs after item 50 remain reachable, and bad page/filter input is graceful`, async () => {
			const f = await fixture(mode);
			const first = await f.seed({ content: "oldest", createdAt: new Date(1000) });
			for (let i = 0; i < 50; i++) await f.seed({ createdAt: new Date(2000 + i) });
			assert.match((await f.execute("list", { page: 11 })).embeds[0].description, new RegExp(String(first._id)));
			for (const page of [-1, 0, 12]) assert.match((await f.execute("list", { page })).content, /page/i);
			assert.match((await f.execute("list", { filter: "invalid" })).content, /filter/i);
		});

		await test(`${mode}: a concurrently emptied page does not produce an empty embed`, async () => {
			const f = await fixture(mode);
			await f.seed();
			const find = f.model.find;
			f.model.find = (query) => { f.model._store.length = 0; return find(query); };
			assert.match((await f.execute("list")).content, /page.*empty/i);
		});

		await test(`${mode}: commands reject DM context without touching storage`, async () => {
			const f = await fixture(mode);
			for (const sub of ["add", "list", "done", "edit", "remove", "clear"]) {
				assert.match((await f.execute(sub, { id: newId(), task: "x" }, { guildId: null })).content, /server/i);
			}
			assert.equal(f.model._calls.length, 0);
		});
	}

	await test("worker: storage capability is enforced and isolation stays enabled", async () => {
		assert.equal(manifest.isolation, true);
		const mock = createMockCtx({ capabilities: {} });
		await load(mock.ctx);
		await assert.rejects(mock.registeredCommands.get("todo").execute(createInteraction("add", { task: "x" }), mock.client), /storage:own-collection/);
	});
	console.log(`\n${passed} passed, ${failed} failed`);
	process.exitCode = failed ? 1 : 0;
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
