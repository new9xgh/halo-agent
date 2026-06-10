import { CommandRegistry } from './registry.js'

export const commandRegistry = new CommandRegistry()

// Command descriptors — single source of truth for the frontend command
// palette, the slash-suggest popup, and `/help` text. Every command listed
// here must have a server-side handler in dispatchCommand
// (channels/shared/commands.ts) so wechat / telegram / web / web-demo
// users can run it. Admin Web UI may additionally intercept some of these
// for nicer local UX (e.g. /new / /help in use-chat.ts), but server-side
// must work too — those intercepts are an optimisation, not a contract.
//
// Pure client-only shortcuts (e.g. /clear in admin Web UI) DO NOT belong
// here. They live as hardcoded keys in the relevant frontend handler so
// non-admin channels never see them in /help and never send them to the
// server expecting a response.
//
// type field is currently only 'server'. Pre-existing 'client' values
// were a leak of an admin-UI-only concept into the cross-channel
// registry; it caused web-demo / wechat / telegram to list dead commands.

commandRegistry.registerDescriptor({ name: 'help',    slashName: '/help',    description: 'Show available commands',                type: 'server', source: 'builtin' })
// Object commands declare their builtin verbs here so completion UIs (admin
// palette, TUI) can suggest them. Keep in sync with SUBCOMMAND_ROUTES — skill
// verbs (e.g. agent create/update) come from the skill's SKILL.md instead.
commandRegistry.registerDescriptor({ name: 'session', slashName: '/session', description: 'Manage sessions', type: 'server', argHint: '<verb>', source: 'builtin', verbs: [
  { name: 'new', builtin: true }, { name: 'list', builtin: true }, { name: 'switch', builtin: true },
  { name: 'stop', builtin: true }, { name: 'interrupt', builtin: true }, { name: 'compact', builtin: true }, { name: 'context', builtin: true },
] })
commandRegistry.registerDescriptor({ name: 'ws',      slashName: '/ws',      description: 'Show or switch workspace',               type: 'server', argHint: '[path]', source: 'builtin' })
commandRegistry.registerDescriptor({ name: 'evo',     slashName: '/evo',     description: 'Queue an evolution run on this session', type: 'server', argHint: '[hint]', source: 'builtin' })
// Object command: list/switch/desc/delete run as builtin verbs (work on every
// agent); create/update fall through to the `agent` skill. Always registered
// so it doesn't depend on the skill being whitelisted.
commandRegistry.registerDescriptor({ name: 'agent',   slashName: '/agent',   description: 'Manage agents', type: 'server', argHint: '<verb>', source: 'builtin', verbs: [
  { name: 'list', builtin: true }, { name: 'switch', builtin: true }, { name: 'desc', builtin: true }, { name: 'delete', builtin: true },
  { name: 'create' }, { name: 'update' },
] })
commandRegistry.registerDescriptor({ name: 'skill',   slashName: '/skill',   description: 'Manage skills', type: 'server', argHint: '<verb>', source: 'builtin', verbs: [
  { name: 'list', builtin: true }, { name: 'desc', builtin: true }, { name: 'disable', builtin: true }, { name: 'enable', builtin: true }, { name: 'delete', builtin: true },
  { name: 'create' }, { name: 'update' },
] })

/** Names (no leading slash) of every registered builtin command. Single source
 *  of truth for channels that need to enumerate commands — e.g. Telegram's
 *  `bot.command()` registration and Slack's `/`→`!` rewrite — so adding a
 *  command here can't silently drift out of a hardcoded per-channel list. */
export function builtinCommandNames(): string[] {
  return commandRegistry.listDescriptors()
    .filter((d) => d.source === 'builtin')
    .map((d) => d.name)
}
