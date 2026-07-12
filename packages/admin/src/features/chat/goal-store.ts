'use client'

import { create } from 'zustand'
import { api } from '@/shared/api-client'

/** `cleared` never reaches the store — the seed endpoint returns null for it
 *  and the WS poke re-fetches through the same endpoint. */
export type GoalStatus = 'intake' | 'running' | 'paused' | 'halted' | 'done'

export interface GoalInfo {
  goalSessionId: string
  workerSessionId: string
  status: GoalStatus
  round: number
  maxRounds: number
}

interface GoalStore {
  goal: GoalInfo | null
  /** Terminal-state (done/halted) banner dismissed for this goal id. In-memory
   *  only — a page refresh brings the banner back, which is fine: terminal
   *  records persist in the db until the next goal replaces them. */
  dismissedGoalId: string | null
  setGoal(goal: GoalInfo | null): void
  dismiss(goalId: string): void
}

export const useGoalStore = create<GoalStore>((set) => ({
  goal: null,
  dismissedGoalId: null,
  setGoal: (goal) => set({ goal }),
  dismiss: (goalId) => set({ dismissedGoalId: goalId }),
}))

/** Seed / refresh the goal state from the server. Called on mount + project
 *  switch (so the banner survives a page refresh) and poked by the
 *  `goal:changed` WS push — the push is global (no workspace marker), so
 *  re-fetching under the active project naturally filters cross-workspace
 *  events: a goal event from another workspace resolves to this workspace's
 *  own (unchanged) state. */
export async function refreshGoal(projectId: string): Promise<void> {
  try {
    const res = await api.sessionLogs.goal(projectId)
    useGoalStore.getState().setGoal((res.goal as GoalInfo | null) ?? null)
  } catch {
    // Unauthenticated / server unreachable — leave current state; the next
    // poke or project switch retries.
  }
}
