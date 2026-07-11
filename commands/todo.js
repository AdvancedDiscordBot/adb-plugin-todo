const { EmbedBuilder } = require("discord.js");

function createTodoCommand(TodoModel, { maxItems = 50 } = {}) {
	return {
		data: {
			name: "todo",
			description: "Manage your personal to-do list",
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

			if (sub === "add") {
				const content = interaction.options.getString("task");
				if (content.length > 1000) {
					return interaction.reply({ content: "Task too long (max 1000 chars).", ephemeral: true });
				}
				const count = await TodoModel.countDocuments({ guildId, userId });
				if (count >= maxItems) {
					return interaction.reply({
						content: `You already have ${count} tasks (max ${maxItems}). Complete some first.`,
						ephemeral: true,
					});
				}
				const item = await TodoModel.create({ guildId, userId, content });
				return interaction.reply({
					content: `📋 Added task \`${item._id}\`: ${content}`,
					ephemeral: true,
				});
			}

			if (sub === "list") {
				const filter = interaction.options.getString("filter") || "pending";
				const query = { guildId, userId };
				if (filter === "pending") query.done = false;
				if (filter === "done") query.done = true;

				const items = await TodoModel.find(query).sort({ createdAt: -1 }).limit(50);
				if (items.length === 0) {
					const msg = filter === "all" ? "No tasks yet." : `No ${filter} tasks.`;
					return interaction.reply({ content: msg, ephemeral: true });
				}

				const embed = new EmbedBuilder()
					.setColor(filter === "done" ? 0x57f287 : 0x5865f2)
					.setTitle(`📋 To-Do List — ${filter}`)
					.setDescription(
						items
							.map((t) => {
								const status = t.done ? "✅" : "⬜";
								const id = `\`${t._id}\``;
								return `${status} ${id} — ${t.content}`;
							})
							.join("\n")
					)
					.setFooter({ text: `${items.length} task(s)` });

				return interaction.reply({ embeds: [embed], ephemeral: true });
			}

			if (sub === "done") {
				const id = interaction.options.getString("id");
				const task = await TodoModel.findOneAndUpdate(
					{ _id: id, guildId, userId, done: false },
					{ done: true, updatedAt: new Date() },
					{ new: true }
				);
				if (!task) {
					return interaction.reply({ content: "Task not found or already completed.", ephemeral: true });
				}
				return interaction.reply({ content: `✅ Marked done: ${task.content}`, ephemeral: true });
			}

			if (sub === "remove") {
				const id = interaction.options.getString("id");
				const result = await TodoModel.deleteOne({ _id: id, guildId, userId });
				if (result.deletedCount === 0) {
					return interaction.reply({ content: "No matching task found.", ephemeral: true });
				}
				return interaction.reply({ content: "🗑️ Task removed.", ephemeral: true });
			}

			if (sub === "edit") {
				const id = interaction.options.getString("id");
				const content = interaction.options.getString("task");
				const task = await TodoModel.findOneAndUpdate(
					{ _id: id, guildId, userId },
					{ content, updatedAt: new Date() },
					{ new: true }
				);
				if (!task) {
					return interaction.reply({ content: "No matching task found.", ephemeral: true });
				}
				return interaction.reply({ content: `✏️ Updated: ${task.content}`, ephemeral: true });
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
