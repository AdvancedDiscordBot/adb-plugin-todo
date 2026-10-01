"use strict";

// Offline contract double, not a worker/broker integration test. Both modes use
// real Mongoose casting/defaults/validation without connecting to a database.
// Direct: hydrated documents, no Model.save or ctx.discord, name-first scheduler.
// Worker: detached documents with save facades, expression-first scheduler,
// capability-gated RPC operations. runTask bypasses Core's cron event transport.
const { Mongoose, Types } = require("mongoose");
const assert = require("node:assert/strict");

function plain(value) {
	if (value == null || typeof value !== "object") return value;
	if (value instanceof Date) return new Date(value);
	if (value._bsontype === "ObjectId") return value.toHexString();
	if (Array.isArray(value)) return value.map(plain);
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plain(item)]));
}

function createFakeModel(fullName, schema, mode, requireCap) {
	const mongoose = new Mongoose();
	const Document = mongoose.model(fullName, schema);
	const store = [];
	const calls = [];
	const valueOf = (value) => value instanceof Date ? value.getTime() : value;

	function checkQuery(query) {
		for (const [key, value] of Object.entries(query)) {
			if (key === "$or" || key === "$and") value.forEach(checkQuery);
			if (key === "_id" && value != null && typeof value !== "object") schema.path("_id").cast(value);
		}
	}

	function matches(doc, query = {}) {
		return Object.entries(query).every(([key, expected]) => {
			if (key === "$or") return expected.some((q) => matches(doc, q));
			if (key === "$and") return expected.every((q) => matches(doc, q));
			const actual = valueOf(doc[key]);
			const cast = (value) => {
				if (value == null) return value;
				if (key === "_id") return String(schema.path("_id").cast(value));
				return valueOf(schema.path(key)?.cast(value) ?? value);
			};
			if (expected && typeof expected === "object" && !(expected instanceof Date) && !expected._bsontype) {
				return Object.entries(expected).every(([op, value]) => {
					if (op === "$exists") return (doc[key] !== undefined) === value;
					if (op === "$in") return value.map(cast).includes(actual);
					if (op === "$nin") return !value.map(cast).includes(actual);
					const wanted = cast(value);
					if (op === "$eq") return wanted == null ? actual == null : actual === wanted;
					if (op === "$ne") return wanted == null ? actual != null : actual !== wanted;
					if (actual == null) return false;
					if (op === "$lte") return actual <= wanted;
					if (op === "$lt") return actual < wanted;
					if (op === "$gte") return actual >= wanted;
					if (op === "$gt") return actual > wanted;
					throw new Error(`Mock does not implement query operator ${op}`);
				});
			}
			return expected == null ? actual == null : actual === cast(expected);
		});
	}

	function record(method, query = {}, extra = {}) {
		requireCap("storage:own-collection");
		calls.push({ method, query: plain(query), ...extra });
		checkQuery(query);
	}

	function result(entry, lean = false) {
		if (!entry) return null;
		if (mode === "worker") {
			const doc = plain(entry);
			if (!lean) Object.defineProperties(doc, {
				markModified: { value: () => {} },
				save: { value: async () => { Object.assign(doc, await model.save(doc, doc)); return doc; } },
			});
			return doc;
		}
		if (lean) return { ...plain(entry), _id: new Types.ObjectId(entry._id) };
		const doc = Document.hydrate(plain(entry));
		doc.save = async () => {
			await doc.validate();
			const data = plain(doc.toObject());
			const index = store.findIndex((row) => row._id === data._id);
			if (index < 0) store.push(data);
			else store[index] = data;
			return doc;
		};
		return doc;
	}

	function query(method, filter = {}) {
		const options = {};
		let execution;
		const execute = async () => {
			record(method, filter, { options: { ...options } });
			let rows = store.filter((row) => matches(row, filter));
			if (options.sort) rows.sort((a, b) => {
				for (const [key, direction] of Object.entries(options.sort)) {
					if (a[key] < b[key]) return -direction;
					if (a[key] > b[key]) return direction;
				}
				return 0;
			});
			if (options.skip) rows = rows.slice(options.skip);
			if (options.limit) rows = rows.slice(0, options.limit);
			calls[calls.length - 1].returned = method === "findOne" ? Math.min(rows.length, 1) : rows.length;
			return method === "findOne" ? result(rows[0], options.lean) : rows.map((row) => result(row, options.lean));
		};
		const exec = () => execution ||= execute();
		const builder = {
			sort(sort) { options.sort = sort; return builder; },
			limit(limit) { options.limit = limit; return builder; },
			skip(skip) { options.skip = skip; return builder; },
			lean(enabled = true) { options.lean = enabled; return builder; },
			exec,
			then(resolve, reject) { return exec().then(resolve, reject); },
			catch(reject) { return exec().catch(reject); },
			finally(fn) { return exec().finally(fn); },
		};
		return builder;
	}

	function applyUpdate(doc, update) {
		for (const [key, value] of Object.entries(update)) {
			if (key === "$set") Object.assign(doc, plain(value));
			else if (key === "$inc") for (const [field, amount] of Object.entries(value)) doc[field] = (doc[field] || 0) + amount;
			else if (key === "$unset") for (const field of Object.keys(value)) delete doc[field];
			else if (key === "$push") for (const [field, item] of Object.entries(value)) (doc[field] ||= []).push(plain(item));
			else if (key !== "$setOnInsert" && key.startsWith("$")) throw new Error(`Mock does not implement update operator ${key}`);
			else if (!key.startsWith("$")) doc[key] = plain(value);
		}
		// updateOne casts but does not run validators by default in either mode.
		Object.assign(doc, plain(new Document(doc).toObject()));
	}

	const model = {
		modelName: fullName,
		find: (filter) => query("find", filter),
		findOne: (filter) => query("findOne", filter),
		findById: (id) => query("findOne", { _id: id }),
		async create(data) {
			record("create");
			const doc = new Document(data);
			await doc.validate();
			const entry = plain(doc.toObject());
			store.push(entry);
			return result(entry);
		},
		async updateOne(filter, update) {
			record("updateOne", filter, { update: plain(update) });
			const doc = store.find((row) => matches(row, filter));
			const before = JSON.stringify(doc);
			if (doc) applyUpdate(doc, update);
			return { acknowledged: true, matchedCount: doc ? 1 : 0, modifiedCount: before !== JSON.stringify(doc) ? 1 : 0 };
		},
		async updateMany(filter, update) {
			record("updateMany", filter);
			const docs = store.filter((row) => matches(row, filter));
			let modifiedCount = 0;
			for (const doc of docs) {
				const before = JSON.stringify(doc);
				applyUpdate(doc, update);
				if (before !== JSON.stringify(doc)) modifiedCount++;
			}
			return { acknowledged: true, matchedCount: docs.length, modifiedCount };
		},
		async findOneAndUpdate(filter, update, options = {}) {
			record("findOneAndUpdate", filter);
			let doc = store.find((row) => matches(row, filter));
			if (!doc && options.upsert) {
				doc = plain(new Document({ ...filter, ...update.$setOnInsert }).toObject());
				store.push(doc);
			}
			if (!doc) return null;
			const before = plain(doc);
			applyUpdate(doc, update);
			return result(options.new || options.returnDocument === "after" ? doc : before);
		},
		async deleteOne(filter) {
			record("deleteOne", filter);
			const index = store.findIndex((row) => matches(row, filter));
			if (index >= 0) store.splice(index, 1);
			return { acknowledged: true, deletedCount: index >= 0 ? 1 : 0 };
		},
		async deleteMany(filter) {
			record("deleteMany", filter);
			const before = store.length;
			for (let i = store.length - 1; i >= 0; i--) if (matches(store[i], filter)) store.splice(i, 1);
			return { acknowledged: true, deletedCount: before - store.length };
		},
		async countDocuments(filter = {}) {
			record("countDocuments", filter);
			return store.filter((row) => matches(row, filter)).length;
		},
		_store: store,
		_calls: calls,
	};
	if (mode === "worker") model.save = async (doc, changes = doc) => {
		record("save", { _id: doc._id });
		const entry = store.find((row) => row._id === String(doc._id));
		if (!entry) throw new Error("Document not found");
		const updated = new Document({ ...entry, ...changes });
		await updated.validate();
		Object.assign(entry, plain(updated.toObject()));
		return result(entry);
	};
	return model;
}

function validatePayload(payload) {
	if (typeof payload === "string") payload = { content: payload };
	assert.ok(payload && typeof payload === "object", "reply must be a string or message options");
	assert.ok((payload.content?.length || 0) <= 2000, "Discord content limit: 2000");
	const embeds = payload.embeds || [];
	assert.ok(embeds.length <= 10, "Discord embed count limit: 10");
	let total = 0;
	for (const embed of embeds) {
		assert.ok((embed.description?.length || 0) <= 4096, "Discord description limit: 4096");
		assert.ok((embed.title?.length || 0) <= 256, "Discord title limit: 256");
		total += (embed.description?.length || 0) + (embed.title?.length || 0) +
			(embed.footer?.text?.length || 0) + (embed.author?.name?.length || 0);
		for (const field of embed.fields || []) total += field.name.length + field.value.length;
	}
	assert.ok(total <= 6000, "Discord aggregate embed text limit: 6000");
}

// Input options are nested just like Discord's subcommand data. This tests the
// registered handler contract, not Core's interaction serialization or replies.
function createInteraction(subcommand, values = {}, { guildId = "guild-1", userId = "user-1", channelId = "channel-1" } = {}) {
	const options = Object.entries(values).map(([name, value]) => ({ name, type: typeof value === "number" ? 4 : 3, value }));
	const replies = [];
	return {
		guildId, channelId, user: { id: userId },
		options: {
			data: subcommand ? [{ name: subcommand, type: 1, options }] : options,
			getSubcommand: () => subcommand,
			getString: (name) => options.find((option) => option.name === name)?.value ?? null,
			getInteger: (name) => options.find((option) => option.name === name)?.value ?? null,
		},
		async reply(payload) {
			assert.equal(replies.length, 0, "interaction may only be replied to once");
			validatePayload(payload);
			replies.push(payload);
		},
		replies,
	};
}

function createMockCtx({ pluginName = require("../plugin.json").name, mode = "worker", capabilities = require("../plugin.json").capabilities } = {}) {
	assert.ok(mode === "worker" || mode === "direct", "unknown mock runtime");
	function requireCap(required) {
		if (mode === "direct") return;
		const [category, value] = required.split(":");
		const granted = capabilities?.[category] || [];
		if (!granted.includes(value) && !granted.includes("*")) throw new Error(`Missing capability: ${required}`);
	}
	const logs = [];
	const logger = Object.fromEntries(["info", "warn", "error", "debug"].map((level) => [level, (...args) => logs.push({ level, args })]));
	const registeredCommands = new Map();
	const registeredEvents = new Map();
	const models = new Map();
	const pluginConfigs = new Map();
	const sent = [];
	const attempts = [];
	const sendHandlers = {};
	const scheduled = new Map();
	const scheduleCalls = [];

	// --- HookBus (direct) / supported hook facade (worker) --------------------
	const handlers = new Map();
	const anyHandlers = new Set();
	const hooks = {
		on(name, handler, priority = 0) {
			requireCap("hooks:subscribe");
			if (!handlers.has(name)) handlers.set(name, []);
			handlers.get(name).push({ handler, priority: mode === "worker" ? 0 : priority });
			handlers.get(name).sort((a, b) => b.priority - a.priority);
			return () => handlers.set(name, handlers.get(name).filter((entry) => entry.handler !== handler));
		},
		off(name, handler) { handlers.set(name, (handlers.get(name) || []).filter((entry) => entry.handler !== handler)); },
		onAny(handler) {
			if (mode === "worker") { logger.warn("hooks.onAny is unavailable in workers"); return () => {}; }
			anyHandlers.add(handler);
			return () => anyHandlers.delete(handler);
		},
		offAny: (handler) => anyHandlers.delete(handler),
		async emitHook(name, payload) {
			requireCap("hooks:emit");
			let current = payload || {};
			for (const handler of anyHandlers) await handler(name, current);
			for (const { handler } of handlers.get(name) || []) {
				const result = await handler(current);
				if (mode === "direct" && result && typeof result === "object") {
					if (result.cancel) return { cancelled: true, payload: current };
					current = { ...current, ...result };
				}
			}
			return mode === "worker" ? { ok: true } : { cancelled: false, payload: current };
		},
	};
	if (mode === "worker") {
		delete hooks.off;
		delete hooks.offAny;
	}

	const db = {
		async getPluginConfig(guildId, name) {
			requireCap("storage:own-collection");
			if (mode === "worker") name = pluginName;
			const key = `${guildId}:${name}`;
			if (!pluginConfigs.has(key)) pluginConfigs.set(key, { guildId, pluginName: name, enabled: false, data: {} });
			return plain(pluginConfigs.get(key));
		},
		async updatePluginConfig(guildId, name, data) {
			requireCap("storage:own-collection");
			if (mode === "worker") name = pluginName;
			const config = { ...await db.getPluginConfig(guildId, name), data: plain(data) };
			pluginConfigs.set(`${guildId}:${name}`, config);
			return plain(config);
		},
		async getAllPluginConfigs(guildId) {
			requireCap("storage:own-collection");
			return [...pluginConfigs.values()].filter((config) => config.guildId === guildId).map(plain);
		},
	};

	async function send(kind, id, payload) {
		validatePayload(payload);
		const attempt = { kind, id, payload: plain(payload) };
		attempts.push(attempt);
		await sendHandlers[kind]?.(attempt);
		sent.push(attempt);
		return mode === "worker" ? { messageId: String(sent.length) } : { id: String(sent.length) };
	}
	const client = mode === "worker" ? null : {
		commands: registeredCommands,
		users: { fetch: async (id) => ({ id, send: (payload) => send("dm", id, payload) }) },
		channels: { cache: new Map(), fetch: async (id) => ({ id, isTextBased: () => true, send: (payload) => send("channel", id, payload) }) },
		guilds: { cache: new Map() },
		user: { id: "mock-bot" },
	};
	const discord = {
		sendDM: async (id, payload) => { requireCap("discord:SendMessages"); return send("dm", id, typeof payload === "string" ? { content: payload } : payload); },
		sendToChannel: async (id, payload) => { requireCap("discord:SendMessages"); return send("channel", id, typeof payload === "string" ? { content: payload } : payload); },
		getGuild: async (id) => { requireCap("discord:GuildInfo"); return { id, name: "Mock Guild" }; },
		getMember: async (guildId, id) => { requireCap("discord:GuildInfo"); return { id, guildId, user: { id }, roles: [] }; },
		fetchChannel: async (id) => { requireCap("discord:ChannelInfo"); return { id, guildId: "guild-1", type: 0 }; },
	};

	function schedule(name, expression, callback) {
		requireCap("scheduler:cron");
		assert.equal(typeof name, "string");
		assert.equal(typeof expression, "string", "cron expression must be a string");
		assert.equal(typeof callback, "function", "cron callback must be a function");
		const taskId = mode === "worker" ? `${pluginName}_task_${scheduleCalls.length + 1}` : name;
		scheduleCalls.push({ name, expression, taskId });
		scheduled.set(taskId, callback);
		return taskId;
	}
	const scheduler = mode === "worker" ? {
		async schedule(expression, callback, name = "task_1") { return schedule(name, expression, callback); },
		async cancel(name) { requireCap("scheduler:cron"); scheduled.delete(name); },
	} : {
		schedule(name, expression, callback) { schedule(name, expression, callback); return { stop: () => scheduled.delete(name) }; },
		unschedule: (name) => scheduled.delete(name),
	};

	const ctx = {
		client, db, scheduler, commands: client?.commands || null, models: null, hooks, logger,
		config: { env: {} }, // Never expose the test runner's real environment.
		async registerCommand(command) {
			assert.equal(typeof command?.execute, "function");
			assert.equal(typeof command?.data?.name, "string");
			registeredCommands.set(command.data.name, command);
		},
		overrideCommand(name, factory) {
			if (mode === "worker") { logger.warn("overrideCommand is unavailable in workers"); return; }
			const command = registeredCommands.get(name);
			command.execute = factory(command.execute, command);
		},
		registerEvent(name, handler, options = {}) {
			if (!registeredEvents.has(name)) registeredEvents.set(name, []);
			registeredEvents.get(name).push({ handler, options });
		},
		defineModel(name, schema) {
			const fullName = `plugin_${pluginName}_${name}`;
			if (!models.has(fullName)) models.set(fullName, createFakeModel(fullName, schema, mode, requireCap));
			return models.get(fullName);
		},
	};
	if (mode === "worker") ctx.discord = discord;
	// Only direct PluginContext currently seals fields; do not invent a worker guarantee.
	if (mode === "direct") {
		for (const key of Object.keys(ctx)) Object.defineProperty(ctx, key, { writable: key === "models", configurable: false });
		Object.preventExtensions(ctx);
	}
	return {
		ctx, client, registeredCommands, registeredEvents, models, pluginConfigs,
		sent, attempts, sendHandlers, scheduled, scheduleCalls, hooks, logs,
		async emitEvent(name, ...args) {
			for (const { handler } of registeredEvents.get(name) || []) await handler(...args, client);
		},
		async runTask(name) {
			assert.ok(scheduled.has(name), `No scheduled task named ${name}`);
			return scheduled.get(name)();
		},
	};
}

module.exports = { createMockCtx, createInteraction, validatePayload, newId: () => new Types.ObjectId().toHexString() };
