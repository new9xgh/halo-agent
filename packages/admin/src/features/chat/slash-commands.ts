import { api } from '@/shared/api-client'

export interface SlashCommand {
  name: string
  description: string
  type: 'client' | 'server'
  argHint?: string
  source?: 'builtin' | 'skill'
  skillId?: string
}

const CLIENT_FALLBACK: SlashCommand[] = [
  { name: '/session', description: 'Manage sessions (new/list/switch/stop/interrupt/compact/context)', type: 'server', argHint: '<verb>' },
  { name: '/clear', description: 'Clear chat (alias for /session new)', type: 'client' },
  { name: '/help', description: 'Show available commands', type: 'client' },
]

let serverCommands: SlashCommand[] = []

export async function refreshCommands(projectId?: string, sessionId?: string, agentId?: string): Promise<void> {
  try {
    const data = await api.commands.list(projectId, sessionId, agentId)
    serverCommands = data.commands.map((d) => ({
      name: d.slashName,
      description: d.description,
      type: d.type,
      argHint: d.argHint,
      source: d.source,
      skillId: d.skillId,
    }))
  } catch {
    serverCommands = []
  }
}

export function getCommands(): SlashCommand[] {
  return serverCommands.length > 0 ? serverCommands : CLIENT_FALLBACK
}

export function matchCommands(input: string): SlashCommand[] {
  if (!input.startsWith('/')) return []
  const lower = input.toLowerCase()
  return getCommands().filter((cmd) => cmd.name.startsWith(lower))
}
