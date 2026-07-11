# adb-plugin-todo

Per-user to-do lists for [Advanced Discord Bot](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot).

## Commands

- `/todo add <task>` — Add a new task
- `/todo list [filter]` — List tasks (all / pending / done)
- `/todo done <id>` — Mark a task as completed
- `/todo remove <id>` — Delete a task
- `/todo edit <id> <task>` — Edit task text
- `/todo clear` — Remove all completed tasks

Tasks are per-user per-server and shown only to you (ephemeral).

## Config

| Key | Default | Description |
|-----|---------|-------------|
| `maxItems` | 50 | Max tasks per user per server |

## License

This project is licensed under the **GNU Affero General Public License v3.0**. See the [LICENSE](LICENSE) file for details.

This repository follows the policies of the main ADB project.

- **Contribution Guidelines**: [CONTRIBUTING.md](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot/blob/main/CONTRIBUTING.md)
- **Code of Conduct**: [CODE_OF_CONDUCT.md](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot/blob/main/CODE_OF_CONDUCT.md)
- **Security Policy**: [SECURITY.md](https://github.com/AdvancedDiscordBot/Advanced-Discord-Bot/blob/main/SECURITY.md)
