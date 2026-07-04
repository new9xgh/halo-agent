/**
 * Pure decision logic for the setup step that closes the top onboarding gap:
 * `halo setup` stores provider keys in settings.yaml, but the seeded built-in
 * agents hardcode aws-bedrock-claude-invoke — so a user with only e.g. a
 * DeepSeek key hits `Could not load credentials from any providers` on their
 * first message. This module decides whether to ask, what options to show,
 * and where the cursor starts; the I/O lives in cmdSetup.
 */

/** Bedrock authenticates with zero configured keys via the AWS credential
 *  chain (env / ~/.aws / EC2 instance role / ECS task role), and chain
 *  availability can't be probed reliably (IMDS probing is slow and flaky) —
 *  so switching the agents away from it is always an explicit user choice,
 *  never automatic. Mirrors FALLBACK_SCAFFOLD_PROVIDER on the server side. */
export const AWS_CHAIN_PROVIDER = 'aws-bedrock-claude-invoke'

/** Sentinel option value for "leave the default agent as-is". */
export const KEEP_CURRENT = '__keep__'

export interface BindProviderPlan {
  /** Context lines printed above the select prompt. */
  intro: string[]
  question: string
  options: Array<{ value: string; label: string; hint?: string }>
  /** Cursor start index into `options`. */
  initialIndex: number
}

/**
 * Build the prompt plan, or null when there's nothing to ask:
 *   - no non-Bedrock provider has keys configured, or
 *   - the default agent is already bound to a provider whose keys are set
 *     (no "key configured but agent unbound" gap to close).
 *
 * Cursor default: with exactly ONE configured provider AND no keys stored for
 * the current provider (the likely-broken fresh-install case), start on the
 * switch option so Enter accepts it. Otherwise start on "Keep current" —
 * e.g. Bedrock users with explicit AWS keys, or multiple candidates where
 * defaulting to any one of them would be a guess.
 */
export function buildBindProviderPlan(
  configured: Array<{ id: string; displayName: string }>,
  currentProvider: string | undefined,
  currentProviderHasKeys: boolean,
): BindProviderPlan | null {
  if (configured.length === 0) return null
  const current = currentProvider ?? AWS_CHAIN_PROVIDER
  if (configured.some((p) => p.id === current)) return null

  const currentIsAwsChain = current === AWS_CHAIN_PROVIDER
  const intro = [
    `Default agent model provider: ${current}${currentIsAwsChain ? ' (works with zero keys via the AWS credential chain: env / ~/.aws / EC2-ECS machine role)' : ''}`,
  ]
  if (currentIsAwsChain) {
    intro.push('If you rely on AWS credentials / a machine role for Bedrock access, choose "Keep" to stay on Bedrock.')
  }

  const options = [
    ...configured.map((p) => ({
      value: p.id,
      label: `Switch default agent to ${p.displayName}`,
      hint: `(${p.id})`,
    })),
    {
      value: KEEP_CURRENT,
      label: `Keep ${current}`,
      hint: currentIsAwsChain ? '(AWS credential chain / machine role)' : '',
    },
  ]
  const initialIndex = configured.length === 1 && !currentProviderHasKeys ? 0 : options.length - 1

  return {
    intro,
    question: 'Bind the default agent to a provider you just configured?',
    options,
    initialIndex,
  }
}
