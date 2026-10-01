# adb-plugin-todo

Per-user to-do lists for [Advanced Discord Bot](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot).

## Commands

- `/todo add <task>` — Add a new task
- `/todo list [filter] [page]` - List tasks (all / pending / done), five per page
- `/todo done <id>` — Mark a task as completed
- `/todo remove <id>` — Delete a task
- `/todo edit <id> <task>` — Edit task text
- `/todo clear` — Remove all completed tasks

Tasks are per-user per-server and shown only to you (ephemeral).
Commands cannot be used in DMs. Add and edit both require nonblank text of at most
1000 characters; malformed IDs produce an explanatory reply, not a database cast error.

Lists are ordered newest first, with database-side pagination. Five full-length
tasks are split across descriptions of at most 4096 characters while staying
below Discord's 6000-character aggregate embed limit. Every task ID remains
reachable with `page`, including tasks beyond the former 50-item display cap.
Unexpected legacy task text longer than 1000 characters is shortened for display.

## Config

| Key | Default | Description |
|-----|---------|-------------|
| `maxItems` | 50 | Max pending tasks per user per server (1-500) |

The limit is read on each add from
`ctx.db.getPluginConfig(guildId, "adb-plugin-todo").data.maxItems`.
Numeric settings are rounded down and clamped to the existing schema range;
missing/non-numeric settings use the default. Completed tasks do not consume
pending capacity. Complete or remove a pending task to make room; `/todo clear`
only removes completed history.

## Runtime and testing

The plugin remains isolated and also works in direct mode. Models and the config
database are injected from `load(ctx)` into the command factory. Core invokes
registered handlers as `execute(interaction, client)`, not `execute(interaction, ctx)`.

Both modes must provide `find().sort().skip().limit().lean()`, `findOne`, `create`,
`countDocuments`, `updateOne` (including `matchedCount`), `deleteOne`, and
`deleteMany`. Updates do not rely on worker-only static `Model.save`, and clear
uses one scoped bulk deletion. Core owns reply forwarding and nested option
resolution in workers. No raw-client or extra capabilities are required.

Run `npm test` for the offline regression suite. It exercises registered commands
with a direct client or worker `null` client, real Mongoose casting/validation over
in-memory storage, and Discord payload limits. It does not connect to Mongo or
Discord and does not test the parent RPC transport.

## License

This project is licensed under the **GNU Affero General Public License v3.0**. See the [LICENSE](LICENSE) file for details.

This repository follows the policies of the main ADB project.

- **Contribution Guidelines**: [CONTRIBUTING.md](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot/blob/main/CONTRIBUTING.md)
- **Code of Conduct**: [CODE_OF_CONDUCT.md](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot/blob/main/CODE_OF_CONDUCT.md)
- **Security Policy**: [SECURITY.md](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot/blob/main/SECURITY.md)
