const { createTodoCommand } = require("./commands/todo");
const todoSchema = require("./models/todo");

async function load(ctx) {
	const TodoModel = ctx.defineModel("todo", todoSchema);

	await ctx.registerCommand(createTodoCommand(TodoModel, ctx.db));

	ctx.logger.info("To-Do plugin loaded");
}

module.exports = { load };
