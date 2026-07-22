"use strict";

/**
 * mock-ctx.js — a bot-faithful, in-memory stand-in for the ISOLATED plugin
 * context the Advanced-Discord-Bot hands a worker-thread plugin.
 *
 * The bot is the source of truth. This mock mirrors
 * core/rpc/worker-bootstrap.js `createShimContext()` + the broker
 * (core/rpc/broker.js) + methods.js capability gating, as closely as is useful
 * for offline testing. Unlike a direct-mode ctx it deliberately does NOT hand
 * back the rich mongoose surface — because a real isolated plugin never gets
 * it. That is the whole point: a test that passes here means the plugin works
 * sandboxed.
 *
 * What it faithfully reproduces:
 *   - ctx.client is `null` (isolated plugins must use ctx.discord).
 *   - ctx.discord exposes ONLY the 5 shim methods: sendToChannel, sendDM,
 *     getGuild, getMember, fetchChannel.
 *   - ctx.defineModel returns an RPC-style proxy: find() resolves to a PLAIN
 *     ARRAY (no .sort()/.limit()/.lean()); the methods are find, findOne,
 *     create, updateOne, deleteOne, countDocuments, save(doc, changes,
 *     markModifiedField). There is NO findOneAndUpdate / deleteMany / doc.save().
 *   - ctx.db exposes the plugin-config surface (getPluginConfig /
 *     updatePluginConfig / getAllPluginConfigs).
 *   - ctx.scheduler = { schedule(expression, cb, name), cancel(name) } — cron
 *     runs in Core; the mock lets the test fire a task by name via runTask().
 *   - ctx.overrideCommand() is unavailable (warns + no-ops), like the shim.
 *   - Every RPC-backed call is CAPABILITY-GATED: if the plugin's plugin.json
 *     does not declare the required capability, the call throws — exactly like
 *     the broker denying it. This is what stops "green tests lie".
 *   - ctx is Object.preventExtensions'd; only `models` is writable.
 *
 * Test-only handles (registeredCommands, registeredEvents, emitEvent, sent,
 * scheduled, runTask, pluginConfigs, hooks) are returned as a SECOND object so
 * the ctx stays faithful to what the bot hands a plugin.
 */

// -- Capability map (mirrors core/rpc/methods.js) ----------------------------
// method family -> required "category:value" capability
const CAP_FOR = {
	"db.getPluginConfig": "storage:own-collection",
	"db.updatePluginConfig": "storage:own-collection",
	"db.getAllPluginConfigs": "storage:own-collection",
	"model.*": "storage:own-collection",
	"discord.sendToChannel": "discord:SendMessages",
	"discord.sendDM": "discord:SendMessages",
	"discord.getGuild": "discord:GuildInfo",
	"discord.getMember": "discord:GuildInfo",
	"discord.fetchChannel": "discord:ChannelInfo",
	"scheduler.schedule": "scheduler:cron",
	"scheduler.cancel": "scheduler:cron",
	"hooks.on": "hooks:subscribe",
	"hooks.emitHook": "hooks:emit",
};

function hasCapability(caps, required) {
	if (!caps) return false;
	const i = required.indexOf(":");
	const cat = required.slice(0, i);
	const val = required.slice(i + 1);
	const list = caps[cat];
	if (!Array.isArray(list)) return false;
	return list.includes("*") || list.includes(val);
}

// -- RPC-style fake model (returns plain values, like the broker) ------------
function createRpcModel(fullName, schema, requireCap) {
	const store = [];
	let idCounter = 1;

	const defaults = {};
	const shapeObj = schema && (schema.obj || schema.tree);
	if (shapeObj) {
		for (const [field, def] of Object.entries(shapeObj)) {
			if (def && typeof def === "object" && "default" in def) defaults[field] = def.default;
		}
	}
	const applyDefaults = (doc) => {
		for (const [field, val] of Object.entries(defaults)) {
			if (doc[field] === undefined) doc[field] = typeof val === "function" ? val() : val;
		}
		return doc;
	};
	const matches = (doc, query = {}) =>
		Object.keys(query).every((k) => {
			if (k === "_id") return String(doc._id) === String(query[k]);
			return doc[k] === query[k];
		});
	// Return plain clones — isolated docs are serialized, not live mongoose docs.
	const clone = (d) => (d == null ? d : { ...d });

	function applyUpdate(doc, update) {
		if (update.$set) Object.assign(doc, update.$set);
		if (update.$inc) for (const [k, v] of Object.entries(update.$inc)) doc[k] = (doc[k] || 0) + v;
		if (update.$push)
			for (const [k, v] of Object.entries(update.$push)) {
				if (!Array.isArray(doc[k])) doc[k] = [];
				doc[k].push(v);
			}
		for (const [k, v] of Object.entries(update)) if (!k.startsWith("$")) doc[k] = v;
	}

	return {
		modelName: fullName,
		async find(query = {}) {
			requireCap("model.*");
			return store.filter((d) => matches(d, query)).map(clone);
		},
		async findOne(query = {}) {
			requireCap("model.*");
			const d = store.find((x) => matches(x, query));
			return d ? clone(d) : null;
		},
		async create(data) {
			requireCap("model.*");
			const entry = applyDefaults({ _id: idCounter++, ...data });
			store.push(entry);
			return clone(entry);
		},
		async updateOne(query = {}, update = {}, opts = {}) {
			requireCap("model.*");
			let doc = store.find((d) => matches(d, query));
			if (!doc && opts.upsert) {
				doc = applyDefaults({ _id: idCounter++, ...query });
				store.push(doc);
			}
			if (doc) applyUpdate(doc, update);
			return { acknowledged: true, modifiedCount: doc ? 1 : 0 };
		},
		async deleteOne(query = {}) {
			requireCap("model.*");
			const idx = store.findIndex((d) => matches(d, query));
			if (idx >= 0) store.splice(idx, 1);
			return { acknowledged: true, deletedCount: idx >= 0 ? 1 : 0 };
		},
		async countDocuments(query = {}) {
			requireCap("model.*");
			return store.filter((d) => matches(d, query)).length;
		},
		// Persist a previously-fetched (plain) doc + its changes — the RPC shim's
		// model.save. There is no doc.save() in isolated mode.
		async save(doc, changes = {}, _markModifiedField) {
			requireCap("model.*");
			const live = store.find((d) => String(d._id) === String(doc._id));
			if (!live) throw new Error(`Document not found: ${doc._id}`);
			Object.assign(live, changes);
			return clone(live);
		},
		_store: store,
	};
}

function createMockCtx({ pluginName = "adb-plugin-REPLACE_ME", capabilities } = {}) {
	// Default to the plugin's own declared capabilities so the gate is real.
	let caps = capabilities;
	if (caps === undefined) {
		try {
			caps = require("../plugin.json").capabilities || {};
		} catch {
			caps = {};
		}
	}
	const requireCap = (method) => {
		const required = CAP_FOR[method];
		if (required && !hasCapability(caps, required)) {
			throw new Error(
				`ctx call "${method}" denied: plugin does not declare capability "${required}". ` +
					`Add it to plugin.json capabilities.`,
			);
		}
	};

	const logger = {
		info: (...a) => console.log("[INFO]", `[${pluginName}]`, ...a),
		warn: (...a) => console.warn("[WARN]", `[${pluginName}]`, ...a),
		error: (...a) => console.error("[ERROR]", `[${pluginName}]`, ...a),
		debug: () => {},
	};

	const registeredCommands = new Map();
	const registeredEvents = new Map();
	const models = new Map();
	const sent = []; // {kind:'channel'|'dm', id, payload}
	const scheduled = new Map(); // name -> callback

	// --- HookBus mirror (subscribe/emit gated by capability) ---
	const handlers = new Map();
	const hooks = {
		on(hookName, handler) {
			requireCap("hooks.on");
			if (!handlers.has(hookName)) handlers.set(hookName, []);
			handlers.get(hookName).push(handler);
			return () => {
				const list = handlers.get(hookName) || [];
				const i = list.indexOf(handler);
				if (i >= 0) list.splice(i, 1);
			};
		},
		onAny() {
			logger.warn("hooks.onAny() is not supported in isolated mode");
			return () => {};
		},
		async emitHook(hookName, payload) {
			requireCap("hooks.emitHook");
			for (const h of handlers.get(hookName) || []) await h(payload);
			return { cancelled: false, payload };
		},
	};

	// --- Plugin-config surface ---
	const pluginConfigs = new Map();
	const db = {
		async getPluginConfig(guildId, pName) {
			requireCap("db.getPluginConfig");
			const key = `${guildId}:${pName}`;
			if (!pluginConfigs.has(key)) pluginConfigs.set(key, { guildId, pluginName: pName, data: {} });
			return pluginConfigs.get(key);
		},
		async updatePluginConfig(guildId, pName, data) {
			requireCap("db.updatePluginConfig");
			const key = `${guildId}:${pName}`;
			const config = { guildId, pluginName: pName, data };
			pluginConfigs.set(key, config);
			return config;
		},
		async getAllPluginConfigs(guildId) {
			requireCap("db.getAllPluginConfigs");
			return [...pluginConfigs.values()].filter((c) => c.guildId === guildId);
		},
	};

	// --- Discord shim (only the 5 methods the worker exposes) ---
	const discord = {
		async sendToChannel(channelId, payload) {
			requireCap("discord.sendToChannel");
			sent.push({ kind: "channel", id: channelId, payload });
			return { ok: true };
		},
		async sendDM(userId, payload) {
			requireCap("discord.sendDM");
			sent.push({ kind: "dm", id: userId, payload });
			return { ok: true };
		},
		async getGuild(guildId) {
			requireCap("discord.getGuild");
			return { id: guildId, name: "Mock Guild", memberCount: 1, icon: null, iconURL: null };
		},
		async getMember(guildId, userId) {
			requireCap("discord.getMember");
			return { id: userId, guildId, user: { id: userId, tag: "User#0001", username: "User", avatarURL: null }, nickname: null, roles: [] };
		},
		async fetchChannel(channelId) {
			requireCap("discord.fetchChannel");
			return { id: channelId, name: "mock-channel", type: 0, guildId: "mock-guild" };
		},
	};

	// --- Scheduler shim ---
	const scheduler = {
		async schedule(expression, callback, name) {
			requireCap("scheduler.schedule");
			const taskId = name || `task_${scheduled.size + 1}`;
			scheduled.set(taskId, callback);
			return taskId;
		},
		async cancel(taskId) {
			requireCap("scheduler.cancel");
			scheduled.delete(taskId);
		},
	};

	// --- ctx methods ---
	function registerCommand(command) {
		if (!command || !command.data || !command.execute) {
			throw new Error("Invalid command: needs data and execute()");
		}
		registeredCommands.set(command.data.name, command);
	}
	function overrideCommand(name) {
		logger.warn(`ctx.overrideCommand("${name}") is not supported in isolated mode.`);
	}
	function registerEvent(name, handler, options = {}) {
		if (!registeredEvents.has(name)) registeredEvents.set(name, []);
		registeredEvents.get(name).push({ handler, options });
	}
	function defineModel(modelName, schema) {
		const fullName = `plugin_${pluginName}_${modelName}`;
		if (!models.has(fullName)) models.set(fullName, createRpcModel(fullName, schema, requireCap));
		return models.get(fullName);
	}

	const ctx = {
		client: null, // isolated: never available
		discord,
		db,
		scheduler,
		commands: null,
		registerCommand,
		overrideCommand,
		registerEvent,
		defineModel,
		models: null, // writable
		hooks,
		config: { env: {} }, // empty unless system:env / system:bot-token
		logger,
	};
	Object.keys(ctx).forEach((k) => {
		Object.defineProperty(ctx, k, { writable: k === "models", configurable: false });
	});
	Object.preventExtensions(ctx);

	// --- test helpers ---
	async function emitEvent(name, ...args) {
		for (const { handler } of registeredEvents.get(name) || []) await handler(...args);
	}
	async function runTask(name) {
		const cb = scheduled.get(name);
		if (!cb) throw new Error(`No scheduled task named "${name}"`);
		return cb();
	}

	return {
		ctx,
		registeredCommands,
		registeredEvents,
		models,
		pluginConfigs,
		sent,
		scheduled,
		emitEvent,
		runTask,
		hooks,
	};
}

module.exports = { createMockCtx };
