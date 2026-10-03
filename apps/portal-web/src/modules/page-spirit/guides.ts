import type {TabId} from '../../types'
import {GUIDES} from './guide-data'

export interface GuideStep { selector: string; instruction: string }
export interface GuideDefinition { label: string; steps: GuideStep[] }

export function getSpiritGuide(pageId: TabId, topicId: string | null): GuideDefinition | null {
  if (!topicId?.startsWith(`${pageId}:`)) return null
  return GUIDES[pageId]?.[topicId] ?? null
}

export function findGuideTarget(root: HTMLElement, step: GuideStep): HTMLElement | null {
  if (root.id !== 'main-content' || !root.isConnected) return null
  try {
    return Array.from(root.querySelectorAll<HTMLElement>(step.selector)).find(element => {
      if (!(element instanceof HTMLElement)) return false
      if (element.closest('[hidden],[inert],[aria-hidden="true"],[aria-busy="true"],dialog,[role="dialog"],[aria-modal="true"],.page-spirit-widget,.game-console')) return false
      if (element.matches(':disabled,[aria-disabled="true"]')) return false
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    }) ?? null
  } catch { return null }
}

export function focusGuideTarget(target: HTMLElement, reducedMotion: boolean): () => void {
  if (!target.isConnected || !target.closest('#main-content')) return () => undefined
  const view = target.ownerDocument.defaultView ?? window
  const scrollers: HTMLElement[] = []
  for (let parent = target.parentElement; parent; parent = parent.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(parent).overflowY) && parent.scrollHeight > parent.clientHeight) scrollers.push(parent)
  }
  const originalMarker = target.getAttribute('data-page-spirit-guide-target')
  const originalTabIndex = target.getAttribute('tabindex')
  const temporaryTabIndex = !target.matches('button,a[href],input,select,textarea,summary,[contenteditable="true"],[tabindex]')
  if (temporaryTabIndex) target.setAttribute('tabindex', '-1')
  target.setAttribute('data-page-spirit-guide-target', 'true')
  const largeRegion = target.getBoundingClientRect().height > (view.visualViewport?.height ?? view.innerHeight) * .5
  target.scrollIntoView({block: largeRegion ? 'start' : 'center', inline: 'nearest', behavior: reducedMotion ? 'instant' : 'smooth'})
  target.focus({preventScroll: true})
  return () => {
    // Stop this navigation at its present position, including after a page
    // change. Never restore an old page's coordinates or a form value.
    if (!reducedMotion) {
      for (const scroller of scrollers) if (scroller.isConnected) scroller.scrollTo({top: scroller.scrollTop, left: scroller.scrollLeft, behavior: 'instant'})
      view.scrollTo({top: view.scrollY, left: view.scrollX, behavior: 'instant'})
    }
    if (originalMarker === null) target.removeAttribute('data-page-spirit-guide-target')
    else target.setAttribute('data-page-spirit-guide-target', originalMarker)
    if (temporaryTabIndex && target.getAttribute('tabindex') === '-1') {
      if (originalTabIndex === null) target.removeAttribute('tabindex')
      else target.setAttribute('tabindex', originalTabIndex)
    }
  }
}
