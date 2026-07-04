import { describe, it, expect } from 'vitest'
import { buildBindProviderPlan, KEEP_CURRENT, AWS_CHAIN_PROVIDER } from '../src/setup-bind-provider.js'

/**
 * Contract for the setup step that closes the "provider key configured but
 * default agent still on Bedrock" onboarding gap. Key invariant: the switch
 * is never automatic — Bedrock can work with ZERO configured keys via the
 * AWS credential chain (env / ~/.aws / EC2-ECS machine role), which can't be
 * probed reliably, so the plan only ever proposes; the user decides.
 */

const deepseek = { id: 'deepseek', displayName: 'DeepSeek' }
const kimi = { id: 'kimi', displayName: 'Kimi' }

describe('buildBindProviderPlan', () => {
  it('returns null when no switchable provider is configured (nothing to ask)', () => {
    expect(buildBindProviderPlan([], AWS_CHAIN_PROVIDER, false)).toBeNull()
  })

  it('returns null when the default agent already uses a configured provider (no gap)', () => {
    expect(buildBindProviderPlan([deepseek], 'deepseek', true)).toBeNull()
  })

  it('single configured provider + keyless Bedrock agent → cursor defaults to the switch', () => {
    const plan = buildBindProviderPlan([deepseek], AWS_CHAIN_PROVIDER, false)
    expect(plan).not.toBeNull()
    expect(plan!.options.map((o) => o.value)).toEqual(['deepseek', KEEP_CURRENT])
    expect(plan!.initialIndex).toBe(0) // Enter accepts the switch
  })

  it('always offers a Keep option — switching away from Bedrock must be explicit', () => {
    const plan = buildBindProviderPlan([deepseek], AWS_CHAIN_PROVIDER, false)!
    const keep = plan.options.find((o) => o.value === KEEP_CURRENT)
    expect(keep).toBeDefined()
    expect(keep!.label).toContain(AWS_CHAIN_PROVIDER)
  })

  it('prompt text warns AWS credential-chain / machine-role users to keep Bedrock', () => {
    const plan = buildBindProviderPlan([deepseek], AWS_CHAIN_PROVIDER, false)!
    const text = plan.intro.join('\n')
    expect(text).toMatch(/credential chain/i)
    expect(text).toMatch(/machine role|role/i)
    expect(text).toMatch(/Keep/)
  })

  it('Bedrock agent WITH explicit AWS keys → cursor defaults to Keep', () => {
    const plan = buildBindProviderPlan([deepseek], AWS_CHAIN_PROVIDER, true)!
    expect(plan.initialIndex).toBe(plan.options.length - 1)
  })

  it('multiple configured providers → all listed, cursor defaults to Keep (no guessing)', () => {
    const plan = buildBindProviderPlan([deepseek, kimi], AWS_CHAIN_PROVIDER, false)!
    expect(plan.options.map((o) => o.value)).toEqual(['deepseek', 'kimi', KEEP_CURRENT])
    expect(plan.initialIndex).toBe(plan.options.length - 1)
  })

  it('missing current provider (unparseable agent.yaml) is treated as Bedrock', () => {
    const plan = buildBindProviderPlan([deepseek], undefined, false)!
    expect(plan.intro[0]).toContain(AWS_CHAIN_PROVIDER)
  })

  it('non-Bedrock current provider without keys still offers the switch, without the AWS caveat', () => {
    const plan = buildBindProviderPlan([deepseek], 'kimi', false)!
    expect(plan.intro.join('\n')).not.toMatch(/credential chain/i)
    expect(plan.options.map((o) => o.value)).toEqual(['deepseek', KEEP_CURRENT])
  })
})
