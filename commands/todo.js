// Plain embeds and shared model CRUD work in both direct and worker modes.
// Capture db here: execute(interaction, client) never receives the plugin ctx.
const { name: PLUGIN_NAME, configSchema } = require("../plugin.json");
const PAGE_SIZE = 5;

function createTodoCommand(TodoModel, db) {
	return {
		data: {
			name: "todo",
			description: "Manage your personal to-do list",
			dm_permission: false,
			options: [
				{
					name: "add",
					description: "Add a new task",
					type: 1,
					options: [
						{
							name: "task",
							type: 3,
							description: "What you need to do",
							required: true,
							min_length: 1,
							max_length: 1000,
						},
					],
				},
				{
					name: "list",
					description: "List your tasks (all / pending / done)",
					type: 1,
					options: [
						{
							name: "filter",
							type: 3,
							description: "Filter: all, pending, or done",
							choices: [
								{ name: "All", value: "all" },
								{ name: "Pending", value: "pending" },
								{ name: "Done", value: "done" },
							],
						},
						{ name: "page", description: "Page number", type: 4, min_value: 1 }, // INTEGER
					],
				},
				{
					name: "done",
					description: "Mark a task as completed",
					type: 1,
					options: [
						{
							name: "id",
							type: 3,
							description: "Task ID (from /todo list)",
							required: true,
						},
					],
				},
				{
					name: "remove",
					description: "Remove a task",
					type: 1,
					options: [
						{
							name: "id",
							type: 3,
							description: "Task ID (from /todo list)",
							required: true,
						},
					],
				},
				{
					name: "edit",
					description: "Edit a task's text",
					type: 1,
					options: [
						{
							name: "id",
							type: 3,
							description: "Task ID (from /todo list)",
							required: true,
						},
						{
							name: "task",
							type: 3,
							description: "New task text",
							required: true,
							min_length: 1,
							max_length: 1000,
						},
					],
				},
				{
					name: "clear",
					description: "Clear all completed tasks",
					type: 1,
				},
			],
		},
		async execute(interaction) {
			const sub = interaction.options.getSubcommand();
			const guildId = interaction.guildId;
			const userId = interaction.user.id;
			if (!guildId) return interaction.reply({ content: "Use this command in a server.", ephemeral: true });

			let content;
			if (sub === "add" || sub === "edit") {
				content = interaction.options.getString("task");
				if (typeof content !== "string" || !content.trim()) {
					return interaction.reply({ content: "Task text cannot be empty.", ephemeral: true });
				}
				if (content.length > 1000) {
					return interaction.reply({ content: "Task too long (max 1000 chars).", ephemeral: true });
				}
			}
			let id;
			if (["done", "edit", "remove"].includes(sub)) {
				id = interaction.options.getString("id");
				if (typeof id !== "string" || !/^[a-f0-9]{24}$/i.test(id)) {
					return interaction.reply({ content: "Invalid task ID. Use an ID from /todo list.", ephemeral: true });
				}
			}

			if (sub === "add") {
				const config = await db.getPluginConfig(guildId, PLUGIN_NAME);
				const configuredMax = config?.data?.maxItems;
				const limits = configSchema.properties.maxItems;
				const maxItems = Number.isFinite(configuredMax)
					? Math.max(limits.minimum, Math.min(limits.maximum, Math.floor(configuredMax)))
					: limits.default;
				const count = await TodoModel.countDocuments({ guildId, userId, done: false });
				if (count >= maxItems) {
					return interaction.reply({
						content: `You already have ${count} pending tasks (max ${maxItems}). Complete or remove a pending task first.`,
						ephemeral: true,
					});
				}
				const item = await TodoModel.create({ guildId, userId, content });
				return interaction.reply({
					content: `📋 Added task \`${item._id}\`: ${content}`,
					allowedMentions: { parse: [] },
					ephemeral: true,
				});
			}

			if (sub === "list") {
				const filter = interaction.options.getString("filter") || "pending";
				if (!["all", "pending", "done"].includes(filter)) {
					return interaction.reply({ content: "Invalid filter. Use all, pending, or done.", ephemeral: true });
				}
				const query = { guildId, userId };
				if (filter === "pending") query.done = false;
				if (filter === "done") query.done = true;

				const count = await TodoModel.countDocuments(query);
				if (count === 0) {
					const msg = filter === "all" ? "No tasks yet." : `No ${filter} tasks.`;
					return interaction.reply({ content: msg, ephemeral: true });
				}
				const pages = Math.ceil(count / PAGE_SIZE);
				const page = interaction.options.getInteger("page") ?? 1;
				if (!Number.isSafeInteger(page) || page < 1 || page > pages) {
					return interaction.reply({ content: `Choose a page between 1 and ${pages}.`, ephemeral: true });
				}
				const items = await TodoModel.find(query).sort({ createdAt: -1, _id: -1 }).skip((page - 1) * PAGE_SIZE).limit(PAGE_SIZE).lean();
				if (items.length === 0) {
					return interaction.reply({ content: "This page is now empty. Run /todo list again.", ephemeral: true });
				}

				// Five full 1000-character tasks fit the 6000-character aggregate.
				// Split descriptions at 4096, retaining every ID and full valid text.
				const color = filter === "done" ? 0x57f287 : 0x5865f2;
				const embeds = [{ color, title: `📋 To-Do List - ${filter}`, description: "" }];
				for (const task of items) {
					const text = String(task.content);
					const preview = text.length > 1000 ? `${text.slice(0, 997)}...` : text;
					const line = `${task.done ? "✅" : "⬜"} \`${task._id}\` - ${preview}`;
					let embed = embeds[embeds.length - 1];
					if (embed.description.length + line.length + 1 > 4096) {
						embed = { color, description: "" };
						embeds.push(embed);
					}
					embed.description += `${embed.description ? "\n" : ""}${line}`;
				}
				embeds[embeds.length - 1].footer = { text: `${count} task(s) | Page ${page}/${pages} | /todo list page:<number>` };

				return interaction.reply({ embeds, ephemeral: true });
			}

			if (sub === "done") {
				const task = await TodoModel.findOne({ _id: id, guildId, userId, done: false });
				if (!task) {
					return interaction.reply({ content: "Task not found or already completed.", ephemeral: true });
				}
				const result = await TodoModel.updateOne({ _id: id, guildId, userId, done: false }, { $set: { done: true, updatedAt: new Date() } });
				if (result.matchedCount !== 1) {
					return interaction.reply({ content: "Task not found or already completed.", ephemeral: true });
				}
				return interaction.reply({ content: `✅ Marked done: ${String(task.content).slice(0, 1000)}`, allowedMentions: { parse: [] }, ephemeral: true });
			}

			if (sub === "remove") {
				const result = await TodoModel.deleteOne({ _id: id, guildId, userId });
				if (!result || result.deletedCount === 0) {
					return interaction.reply({ content: "No matching task found.", ephemeral: true });
				}
				return interaction.reply({ content: "🗑️ Task removed.", ephemeral: true });
			}

			if (sub === "edit") {
				const result = await TodoModel.updateOne({ _id: id, guildId, userId }, { $set: { content, updatedAt: new Date() } });
				if (result.matchedCount !== 1) {
					return interaction.reply({ content: "No matching task found.", ephemeral: true });
				}
				return interaction.reply({ content: `✏️ Updated: ${content}`, allowedMentions: { parse: [] }, ephemeral: true });
			}

			if (sub === "clear") {
				const result = await TodoModel.deleteMany({ guildId, userId, done: true });
				return interaction.reply({
					content: `🗑️ Cleared ${result.deletedCount} completed task(s).`,
					ephemeral: true,
				});
			}
		},
	};
}

module.exports = { createTodoCommand };
