export type User = {
  user_id: string
  display_name: string
  email: string
  profession_membership_ref: string
}

export type SessionPayload = {
  user: User
  csrf_token: string
}

export type ProblemDetails = {
  type?: string
  title?: string
  status?: number
  detail?: string
  code?: string
}

export type ParticipationTerms = {
  schema_version?: string
  participation_mode?: string
  beneficiary?: {
    party_ref?: string | null
    problem?: string
    intended_gain?: string
  }
  contributor_gain?: {
    kind?: string
    description?: string
    assurance?: string
    resource_refs?: string[]
  }
  effort?: {
    estimated_minutes?: number
    maximum_minutes?: number
  }
  shared_goal_ref?: string | null
  human_support?: {
    promised?: boolean
    reservation_ref?: string | null
    scope?: string
    no_capacity_fallback?: string
  }
  completion?: {
    criteria?: string[]
    claim_by?: string
    finish_by?: string
    feedback_due?: string
    unanswered_outcome?: string
  }
  reuse?: {
    visibility?: string
    artifact_license_ref?: string | null
    consent_required?: boolean
  }
  funding?: unknown
  newcomer_friendly?: boolean
}

export type ClaimState =
  | 'claimed'
  | 'in_progress'
  | 'submitted'
  | 'in_review'
  | 'changes_requested'
  | 'accepted'

export type WorkSubmission = {
  submission_id: string
  summary: string
  artifact_ref: string
  sha256: string
}

export type WorkClaim = {
  claim_id: string
  work_item_id: string
  claimant_ref: string
  state: ClaimState
  aggregate_version: number
  latest_submission: WorkSubmission | null
  feedback: string | null
}

export type WorkItem = {
  work_item_id: string
  title: string
  objective: string
  acceptance_criteria: string
  gain: string
  state: string
  aggregate_version: number
  owner_ref: string
  terms_status: 'declared' | string
  participation_terms_revision: number
  participation_terms_sha256: string
  participation_terms: ParticipationTerms | null
  claim_window_expires_at: string
  due_at: string
  review_capacity: 'available' | 'waiting_reviewer_capacity' | string
  my_claim: WorkClaim | null
}

export type GainedItem = {
  contribution_id: string
  work_item_id: string
  title: string
  summary: string
  artifact_ref: string
  accepted_at: string
  official: boolean
}

export type ReviewQueueItem = {
  claim: WorkClaim
  work_item: WorkItem
  claimant_name: string
}

export type Dashboard = {
  now: WorkItem[]
  next: WorkItem[]
  gained: GainedItem[]
  review_queue: ReviewQueueItem[]
  summary: { accepted_count: number }
}

export type Showcase = {
  showcase_id: string
  owner_ref: string
  owner_name: string
  title: string
  description: string
  artifact_ref: string
  visibility: 'community' | string
  aggregate_version: number
}

export type Opportunity = {
  opportunity_id: string
  showcase_id: string
  showcase_title: string
  provider_ref: string
  client_ref: string
  client_name: string
  provider_name: string
  need: string
  state: 'open' | 'proposed' | string
  aggregate_version: number
}

export type Receipt = {
  receipt_id: string
  amount_minor: string
  currency: string
  evidence_ref: string
  received_at: string
  verification_status: 'self_reported' | 'counterparty_confirmed' | string
}

export type Engagement = {
  engagement_id: string
  provider_ref: string
  client_ref: string
  provider_name: string
  client_name: string
  scope: string
  acceptance_criteria: string
  amount_minor: string
  currency: string
  state: 'proposed' | 'agreed' | 'delivered' | 'accepted' | string
  aggregate_version: number
  terms_sha256: string
  delivery_ref: string | null
  receipt: Receipt | null
}

export type TabId = 'skills' | 'guild-workspace' | 'cocreation' | 'account' | 'members' | 'community' | 'squads' | 'home' | 'positioning' | 'supplier' | 'retail' | 'opensource' | 'marketing' | 'guilds' | 'workbench' | 'showcase' | 'engagement'
