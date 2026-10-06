import React from 'react'
import { ApiError, PortalClient } from './api'
import type { SessionPayload, User } from './types'

// One client/session envelope shared by the shell and its feature modules.
export const client = new PortalClient()

export type ActionError = {
  message: string
  network: boolean
  conflict: boolean
  accessExpired?: boolean
  retry?: () => void
}

export type PortalContextValue = {
  session: SessionPayload
  pending: string | null
  error: ActionError | null
  mutate: (actionId: string, fn: (key: string) => Promise<void>) => Promise<boolean>
  clearError: () => void
  isMe: (ref: string | null | undefined) => boolean
}

export const PortalContext = React.createContext<PortalContextValue | null>(null)

export function usePortal(): PortalContextValue {
  const ctx = React.useContext(PortalContext)
  if (!ctx) throw new Error('工作區內容尚未就緒')
  return ctx
}

export function isOwnRef(user: User, ref: string | null | undefined): boolean {
  if (!ref) return false
  return ref === user.user_id || ref === user.profession_membership_ref || ref === user.email
}

export function describeError(err: unknown): ActionError {
  if (err instanceof ApiError) {
    return {
      message: err.message,
      network: err.network,
      conflict: err.conflict,
      accessExpired: err.accessExpired,
    }
  }
  if (err instanceof Error) {
    return { message: err.message, network: false, conflict: false }
  }
  return { message: '發生未預期的錯誤', network: false, conflict: false }
}

