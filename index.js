const { createTodoCommand } = require("./commands/todo");
const todoSchema = require("./models/todo");

const DEFAULT_MAX_ITEMS = 50;

async function load(ctx) {
	const TodoModel = ctx.defineModel("todo", todoSchema);

	ctx.registerCommand(createTodoCommand(TodoModel, { maxItems: DEFAULT_MAX_ITEMS }));

	ctx.logger.info("To-Do plugin loaded");
}

module.exports = { load };
