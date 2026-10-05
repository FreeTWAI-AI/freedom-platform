// Generic behavior adapted from mars-tw PR #106, source 46a40342509a9278c3a7b8a940bce27b7f464227.
// Inline companion UI adapted from mars-tw 99b90451b1b047a34d443318a21e4aad973ae226.
import {useCallback, useEffect, useId, useRef, useState, type CSSProperties, type FormEvent} from 'react'
import type {GuidePage,GuideCharacter} from '../contracts'
import {GuideGallery} from './GuideGallery'
import {createPageSession, type SpiritPack} from './core'
import {findGuideTarget, focusGuideTarget, type GuideDefinition} from './guides'
import {readSpiritPreferences, writeSpiritPreferences, type SpiritPreferences} from './preferences'
import './page-spirit.css'

type Props = {pageId: string; scopeKey: string; page:GuidePage; label:string; gallery:readonly GuideCharacter[]; disabled?: boolean}
type SpiritState = 'idle' | 'wave' | 'think' | 'cheer' | 'calm' | 'sleep'
type LoadState = 'idle' | 'loading' | 'ready' | 'error'
type ViewMode = 'closed' | 'expanded' | 'compact' | 'guide'
type CanonicalLine = {text: string; topicId: string | null}
type GuideState = {definition: GuideDefinition; index: number; found: boolean; identity: string}
const FRAME_ORDER = [0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0] as const
const MODAL_SELECTOR = 'dialog[open],[aria-modal="true"],[role="dialog"],.modal-overlay,.modal-backdrop,.world-chat-drawer,.world-chat-overlay'
const ENVIRONMENT_SELECTOR = `${MODAL_SELECTOR},.game-console`

function visible(element: HTMLElement) {
  if (element.hidden || element.closest('[hidden],[aria-hidden="true"]')) return false
  const style = getComputedStyle(element)
  const rect = element.getBoundingClientRect()
  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
}

function editing(element: Element | null) {
  return element instanceof HTMLElement && (element.isContentEditable || element.matches('input,textarea,select'))
}

function blockingSurface(own: HTMLElement | null) {
  return Array.from(document.querySelectorAll<HTMLElement>(MODAL_SELECTOR)).some(element => !own?.contains(element) && visible(element))
    || Array.from(document.querySelectorAll<HTMLElement>('.game-console-expanded')).some(visible)
}

export function GuideEngine({pageId, scopeKey, page, label, gallery, disabled = false}: Props) {
  const character = page.character
  const getSpiritGuide = (_pageId:string, topicId:string|null) => topicId?.startsWith(`${pageId}:`) ? page.guides[topicId] ?? null : null
  const [galleryOpen,setGalleryOpen] = useState(false)
  const identity = `${scopeKey}:${pageId}`
  const uid = useId()
  const [preferences, setPreferences] = useState(readSpiritPreferences)
  const preferenceRef = useRef(preferences)
  preferenceRef.current = preferences
  const wrapper = useRef<HTMLDivElement>(null)
  const launcher = useRef<HTMLButtonElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const questionInput = useRef<HTMLInputElement>(null)
  const compactContinue = useRef<HTMLButtonElement>(null)
  const showFullButton = useRef<HTMLButtonElement>(null)
  const content = useRef<HTMLElement>(null)
  const mounted = useRef(false)
  const active = useRef({identity, open: false, mode: 'closed' as ViewMode, disabled, suppressed: false, energy: preferences.energy, instantText: preferences.instantText, reduced: false})
  active.current.identity = identity
  active.current.disabled = disabled
  const currentCharacter = useRef(character)
  currentCharacter.current = character
  const session = useRef<ReturnType<typeof createPageSession> | null>(null)
  const currentPack = useRef<SpiritPack | null>(null)
  const packIdentity = useRef('')
  const lineIdentity = useRef('')
  const packEpoch = useRef(0)
  const hasOpened = useRef(false)
  const spriteRequest = useRef(0), spriteGeneration = useRef(0)
  const textRequest = useRef(0), textGeneration = useRef(0)
  const focusRequest = useRef(0)
  const frameImages = useRef<HTMLImageElement[]>([])
  const framePromise = useRef<Promise<void> | null>(null)
  const fullText = useRef('')
  const composing = useRef(false)
  const canonical = useRef<CanonicalLine[]>([])
  const canonicalCursor = useRef(-1)
  const currentTopic = useRef<string | null>(null)
  const guideTarget = useRef<HTMLElement | null>(null)
  const guideCleanup = useRef<(() => void) | null>(null)
  const guideEpoch = useRef(0)
  const guideIdentity = useRef('')
  const guideState = useRef<GuideState | null>(null)
  const [historyPosition, setHistoryPosition] = useState(-1)
  const [mode, setMode] = useState<ViewMode>('closed')
  const [questionsOpen, setQuestionsOpen] = useState(false)
  const [guideMenuOpen, setGuideMenuOpen] = useState(false)
  const open = questionsOpen
  const [guide, setGuide] = useState<GuideState | null>(null)
  const [suppressed, setSuppressed] = useState(false)
  const [hardSuppressed, setHardSuppressed] = useState(false)
  const [loadState, setLoadState] = useState<LoadState>('idle')
  const [pack, setPack] = useState<SpiritPack | null>(null)
  const [question, setQuestion] = useState('')
  const [line, setLine] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const [announcementRevision, setAnnouncementRevision] = useState(0)
  const [typing, setTyping] = useState(false)
  const [sprite, setSprite] = useState<{src: string; index: number | 'hero'; playing: boolean; identity: string}>({src: character.hero, index: 'hero', playing: false, identity})

  const permitted = useCallback((expectedIdentity: string) => mounted.current && active.current.identity === expectedIdentity
    && active.current.open && !active.current.disabled && !active.current.suppressed && !document.hidden, [])
  const motionPermitted = useCallback((expectedIdentity: string) => permitted(expectedIdentity)
    && !active.current.energy && !active.current.reduced, [permitted])
  const textMotionPermitted = useCallback((expectedIdentity: string) => motionPermitted(expectedIdentity) && !active.current.instantText, [motionPermitted])

  const clearGuide = useCallback(() => {
    guideEpoch.current++
    guideCleanup.current?.(); guideCleanup.current = null; guideTarget.current = null; guideIdentity.current = ''; guideState.current = null
    if (mounted.current) setGuide(null)
  }, [])
  const unavailableGuideTarget = useCallback(() => {
    const current = guideState.current
    if (!current || current.identity !== active.current.identity || !current.found) return
    guideEpoch.current++; guideCleanup.current?.(); guideCleanup.current = null
    if (!guideTarget.current?.isConnected) guideTarget.current = null
    const next = {...current, found: false}
    guideState.current = next; setGuide(next)
    setAnnouncement(`${current.definition.steps[current.index].instruction} 這個入口目前無法使用，請先查看本頁提示。`)
  }, [])

  const stopSprite = useCallback(() => {
    spriteGeneration.current++
    if (spriteRequest.current) cancelAnimationFrame(spriteRequest.current)
    spriteRequest.current = 0
    if (mounted.current) setSprite({src: currentCharacter.current.hero, index: 'hero', playing: false, identity: active.current.identity})
  }, [])
  const stopText = useCallback((complete = true) => {
    textGeneration.current++
    if (textRequest.current) cancelAnimationFrame(textRequest.current)
    textRequest.current = 0
    if (mounted.current) {
      if (complete) setLine(fullText.current)
      if (complete && active.current.open && document.activeElement === showFullButton.current) closeButton.current?.focus({preventScroll: true})
      setTyping(false)
    }
  }, [])
  const cancelMotion = useCallback((complete = true) => {
    stopSprite(); stopText(complete)
    if (focusRequest.current) cancelAnimationFrame(focusRequest.current)
    focusRequest.current = 0
  }, [stopSprite, stopText])
  const forgetFrames = useCallback(() => {
    frameImages.current.forEach(image => image.removeAttribute('src'))
    frameImages.current = []
    framePromise.current = null
  }, [])

  const close = useCallback((returnFocus = false, clear = false) => {
    const expectedIdentity = active.current.identity
    active.current.open = false
    active.current.mode = 'closed'
    packEpoch.current++
    cancelMotion(!clear)
    forgetFrames()
    clearGuide()
    if (mounted.current) {
      setMode('closed'); setQuestionsOpen(false); setGuideMenuOpen(false); setGalleryOpen(false); setAnnouncement(''); setQuestion(''); composing.current = false
      if (!currentPack.current) setLoadState('idle')
    }
    if (clear) {
      session.current?.clear(); session.current = null; currentPack.current = null; packIdentity.current = ''
      fullText.current = ''; lineIdentity.current = ''; hasOpened.current = false
      currentTopic.current = null; canonical.current = []; canonicalCursor.current = -1; composing.current = false
      if (mounted.current) {setPack(null); setLoadState('idle'); setLine(''); setQuestion(''); setHistoryPosition(-1)}
    }
    if (returnFocus) focusRequest.current = requestAnimationFrame(() => {
      focusRequest.current = 0
      if (mounted.current && active.current.identity === expectedIdentity && active.current.mode === 'closed' && !active.current.disabled && !active.current.suppressed
        && !document.hidden && !blockingSurface(wrapper.current)
        && (!editing(document.activeElement) || wrapper.current?.contains(document.activeElement))) {
        launcher.current?.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'})
        launcher.current?.focus({preventScroll: true})
      }
    })
  }, [cancelMotion, clearGuide, forgetFrames])

  const showLine = useCallback((text: string, topicId: string | null = null, record = true, animate = true) => {
    stopText(false)
    fullText.current = text
    lineIdentity.current = active.current.identity
    currentTopic.current = topicId
    if (record) {
      const entries = canonical.current.slice(0, canonicalCursor.current + 1)
      entries.push({text, topicId})
      canonical.current = entries.slice(-6)
      canonicalCursor.current = canonical.current.length - 1
      setHistoryPosition(canonicalCursor.current)
    }
    setAnnouncement(text)
    setAnnouncementRevision(value => value + 1)
    content.current?.scrollTo({top: 0, behavior: 'instant'})
    const characters = Array.from(text)
    const expectedIdentity = active.current.identity
    if (!animate || !textMotionPermitted(expectedIdentity) || characters.length <= 1) {setLine(text); return}
    const generation = textGeneration.current, start = performance.now()
    const duration = Math.min(3000, characters.length / 30 * 1000)
    let count = 1
    setLine(characters[0]); setTyping(true)
    const step = (time: number) => {
      if (generation !== textGeneration.current || !mounted.current || active.current.identity !== expectedIdentity) return
      textRequest.current = 0
      const elapsed = time - start
      if (!textMotionPermitted(expectedIdentity) || elapsed >= duration) {stopText(true); return}
      const next = Math.max(1, Math.floor(Math.max(0, elapsed) / duration * characters.length))
      if (next !== count) {count = next; setLine(characters.slice(0, next).join(''))}
      textRequest.current = requestAnimationFrame(step)
    }
    textRequest.current = requestAnimationFrame(step)
  }, [textMotionPermitted, stopText])

  const playSprite = useCallback(() => {
    stopSprite()
    const expectedIdentity = active.current.identity, actor = currentCharacter.current
    const generation = spriteGeneration.current
    if (!motionPermitted(expectedIdentity) || actor.frames.length !== 6) return
    if (!framePromise.current) {
      const images = actor.frames.map((src: string) => {const image = new Image(); image.decoding = 'async'; image.src = src; return image})
      frameImages.current = images
      framePromise.current = Promise.all(images.map((image: HTMLImageElement) => image.decode())).then(() => undefined)
    }
    void framePromise.current.then(() => {
      if (generation !== spriteGeneration.current || !motionPermitted(expectedIdentity)) return
      const start = performance.now()
      let last = 0
      setSprite({src: actor.frames[0], index: 0, playing: true, identity: expectedIdentity})
      const step = (time: number) => {
        if (generation !== spriteGeneration.current || !mounted.current || active.current.identity !== expectedIdentity) return
        spriteRequest.current = 0
        const elapsed = time - start
        if (!motionPermitted(expectedIdentity) || elapsed >= 1500) {stopSprite(); return}
        const index = FRAME_ORDER[Math.floor(Math.max(0, elapsed) / 1500 * FRAME_ORDER.length)]
        if (index !== last) {last = index; setSprite({src: actor.frames[index], index, playing: true, identity: expectedIdentity})}
        spriteRequest.current = requestAnimationFrame(step)
      }
      spriteRequest.current = requestAnimationFrame(step)
    }).catch(() => {
      if (generation === spriteGeneration.current && mounted.current && active.current.identity === expectedIdentity) {stopSprite(); forgetFrames()}
    })
  }, [forgetFrames, motionPermitted, stopSprite])

  const loadPack = useCallback(async () => {
    const expectedIdentity = active.current.identity, expectedPage = pageId
    const epoch = ++packEpoch.current
    setLoadState('loading')
    stopText(false)
    fullText.current = `我在整理「${currentCharacter.current.title}」的說明。`
    lineIdentity.current = expectedIdentity
    setLine(fullText.current); setAnnouncement(fullText.current)
    try {
      const loaded = await page.loadContent()
      if (epoch !== packEpoch.current || !permitted(expectedIdentity)) return
      if (loaded.id !== expectedPage) throw new Error('Incorrect page pack')
      const bound = {...loaded, characterName: currentCharacter.current.name}
      currentPack.current = bound; packIdentity.current = expectedIdentity; session.current = createPageSession(bound)
      setPack(bound); setLoadState('ready'); hasOpened.current = true
      showLine(bound.entryLine); playSprite()
    } catch {
      if (epoch !== packEpoch.current || !permitted(expectedIdentity)) return
      currentPack.current = null; packIdentity.current = ''; session.current = null
      setPack(null); setLoadState('error')
      showLine('這一頁的說明暫時沒載入。再試一次，我會留在這一頁。', null, false)
    }
  }, [page, pageId, permitted, playSprite, showLine, stopText])

  const begin = useCallback((origin?: HTMLElement, intent: 'questions' | 'guides' = 'questions') => {
    if (active.current.disabled || document.hidden || blockingSurface(wrapper.current)) return
    if (focusRequest.current) cancelAnimationFrame(focusRequest.current)
    origin?.focus({preventScroll: true})
    active.current.suppressed = false; setSuppressed(false)
    clearGuide()
    active.current.open = true
    active.current.mode = 'expanded'
    setMode('expanded')
    setQuestionsOpen(intent === 'questions'); setGuideMenuOpen(intent === 'guides')
    if (currentPack.current && session.current && packIdentity.current === active.current.identity) {
      showLine(hasOpened.current ? fullText.current || currentPack.current.entryLine : currentPack.current.entryLine, currentTopic.current, false, false)
      hasOpened.current = true; playSprite()
    } else void loadPack()
    focusRequest.current = requestAnimationFrame(() => {
      focusRequest.current = 0
      const own = wrapper.current
      const blocked = blockingSurface(own)
      if (intent === 'questions' && permitted(active.current.identity) && !blocked && (!editing(document.activeElement) || own?.contains(document.activeElement))) closeButton.current?.focus({preventScroll: true})
    })
  }, [clearGuide, loadPack, permitted, playSprite, showLine])

  const minimize = useCallback(() => {
    clearGuide()
    active.current.open = false; active.current.mode = 'compact'
    packEpoch.current++; cancelMotion(true)
    if (!currentPack.current) setLoadState('idle')
    setMode('compact'); setQuestionsOpen(false); setGuideMenuOpen(false); setAnnouncement('')
    composing.current = false
    focusRequest.current = requestAnimationFrame(() => {
      focusRequest.current = 0
      if (mounted.current && active.current.mode === 'compact' && !active.current.suppressed && !active.current.disabled
        && !document.hidden && !blockingSurface(wrapper.current)) {
        compactContinue.current?.scrollIntoView({block: 'center', inline: 'nearest', behavior: 'instant'})
        compactContinue.current?.focus({preventScroll: true})
      }
    })
  }, [cancelMotion, clearGuide])

  const moveGuide = useCallback((definition: GuideDefinition, index: number) => {
    const expectedIdentity = active.current.identity
    if (!mounted.current || active.current.disabled || active.current.suppressed || document.hidden || !definition.steps[index]) return
    const root = document.getElementById('main-content')
    const step = definition.steps[index]
    const target = root instanceof HTMLElement ? findGuideTarget(root, step) : null
    clearGuide()
    const epoch = guideEpoch.current
    guideIdentity.current = expectedIdentity; guideTarget.current = target
    active.current.open = false; active.current.mode = 'guide'
    packEpoch.current++; cancelMotion(true)
    composing.current = false; setQuestion('')
    setQuestionsOpen(false); setGuideMenuOpen(false)
    const next = {definition, index, found: Boolean(target), identity: expectedIdentity}
    guideState.current = next; setMode('guide'); setGuide(next)
    setAnnouncement(target ? step.instruction : `${step.instruction} 這個入口目前無法使用，請先查看本頁提示。`)
    if (target) {
      // The inline explanation changes the document layout when it collapses.
      // Revalidate and focus the named control after React commits that change.
      focusRequest.current = requestAnimationFrame(() => {
        focusRequest.current = 0
        if (epoch !== guideEpoch.current || active.current.identity !== expectedIdentity || !mounted.current || active.current.disabled
          || active.current.suppressed || document.hidden || blockingSurface(wrapper.current) || !target.isConnected) return
        const currentRoot = document.getElementById('main-content')
        if (!(currentRoot instanceof HTMLElement) || findGuideTarget(currentRoot, step) !== target) {unavailableGuideTarget(); return}
        const cleanup = focusGuideTarget(target, active.current.reduced || active.current.energy)
        if (epoch !== guideEpoch.current || active.current.identity !== expectedIdentity || !mounted.current || active.current.disabled || !target.isConnected) {cleanup(); return}
        guideCleanup.current = cleanup
      })
    }
  }, [cancelMotion, clearGuide, unavailableGuideTarget])

  const startGuide = useCallback(() => {
    if (!permitted(active.current.identity) || packIdentity.current !== active.current.identity) return
    const definition = getSpiritGuide(pageId, currentTopic.current)
    if (definition?.steps.length) moveGuide(definition, 0)
  }, [moveGuide, pageId, permitted])

  const chooseGuide = useCallback((topicId: string) => {
    if (!permitted(active.current.identity) || packIdentity.current !== active.current.identity || !session.current) return
    const topic = currentPack.current?.topics.find(entry => entry.id === topicId)
    const definition = getSpiritGuide(pageId, topicId)
    if (!topic || !definition?.steps.length) return
    const reply = session.current.ask(topic.label, topic.id, currentTopic.current)
    showLine(reply.text, reply.topicId)
    moveGuide(definition, 0)
  }, [moveGuide, pageId, permitted, showLine])

  const previous = useCallback(() => {
    if (!permitted(active.current.identity) || canonicalCursor.current <= 0) return
    canonicalCursor.current--
    const entry = canonical.current[canonicalCursor.current]
    setHistoryPosition(canonicalCursor.current); stopSprite()
    showLine(entry.text, entry.topicId, false, false)
  }, [permitted, showLine, stopSprite])

  const latest = useCallback(() => {
    if (!permitted(active.current.identity) || !canonical.current.length) return
    canonicalCursor.current = canonical.current.length - 1
    const entry = canonical.current[canonicalCursor.current]
    setHistoryPosition(canonicalCursor.current); stopSprite()
    showLine(entry.text, entry.topicId, false, false)
    closeButton.current?.focus({preventScroll: true})
  }, [permitted, showLine, stopSprite])

  const restart = useCallback(() => {
    const trusted = currentPack.current
    if (!trusted || packIdentity.current !== active.current.identity || !permitted(active.current.identity)) return
    clearGuide(); cancelMotion(false)
    session.current?.clear(); session.current = createPageSession(trusted)
    canonical.current = []; canonicalCursor.current = -1; currentTopic.current = null; composing.current = false
    setQuestion(''); setHistoryPosition(-1)
    showLine(trusted.entryLine); playSprite()
  }, [cancelMotion, clearGuide, permitted, playSprite, showLine])

  const ask = useCallback((input: string, topicId?: string) => {
    if (!session.current || !currentPack.current || packIdentity.current !== active.current.identity || !permitted(active.current.identity)) return
    const result = session.current.ask(input, topicId, currentTopic.current)
    setQuestion(''); showLine(result.text, result.topicId)
    const state = result.state as SpiritState
    if (state === 'wave' || state === 'think' || state === 'cheer') playSprite()
    else stopSprite()
  }, [permitted, playSprite, showLine, stopSprite])
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (composing.current) return
    const text = question.trim()
    if (text) ask(text)
  }

  useEffect(() => {
    mounted.current = true
    close(false, true)
    return () => {
      mounted.current = false; active.current.open = false; packEpoch.current++
      cancelMotion(false); forgetFrames(); session.current?.clear(); session.current = null; currentPack.current = null; packIdentity.current = ''
      clearGuide(); fullText.current = ''; lineIdentity.current = ''; canonical.current = []; canonicalCursor.current = -1; currentTopic.current = null
    }
  }, [identity, cancelMotion, clearGuide, close, forgetFrames])

  useEffect(() => {if (disabled) close(false, true)}, [disabled, close])
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    active.current.reduced = media.matches
    const changed = () => {active.current.reduced = media.matches; cancelMotion(true)}
    const visibility = () => {if (document.hidden) close(false)}
    const sessionEnded = () => close(false, true)
    const guideEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229 || active.current.mode !== 'guide'
        || guideIdentity.current !== active.current.identity || !guideState.current) return
      const own = wrapper.current
      const modalOpen = Array.from(document.querySelectorAll<HTMLElement>(MODAL_SELECTOR)).some(element => !own?.contains(element) && visible(element))
      const consoleOpen = Array.from(document.querySelectorAll<HTMLElement>('.game-console-expanded')).some(visible)
      if (modalOpen || consoleOpen) return
      event.preventDefault(); event.stopPropagation(); close(false)
    }
    media.addEventListener('change', changed)
    document.addEventListener('visibilitychange', visibility)
    document.addEventListener('keydown', guideEscape)
    window.addEventListener('freedom-game-console-session-end', sessionEnded)
    return () => {
      media.removeEventListener('change', changed)
      document.removeEventListener('visibilitychange', visibility)
      document.removeEventListener('keydown', guideEscape)
      window.removeEventListener('freedom-game-console-session-end', sessionEnded)
    }
  }, [cancelMotion, close])

  useEffect(() => {
    let layoutRequest = 0
    const inspect = () => {
      layoutRequest = 0
      const own = wrapper.current
      const consoles = Array.from(document.querySelectorAll<HTMLElement>('.game-console')).filter(element => !own?.contains(element))
      const consoleOpen = consoles.some(element => element.classList.contains('game-console-expanded') && visible(element))
      const modalOpen = Array.from(document.querySelectorAll<HTMLElement>(MODAL_SELECTOR)).some(element => !own?.contains(element) && visible(element))
      const guidedFocus = active.current.mode === 'guide' && guideIdentity.current === active.current.identity
        && guideTarget.current?.isConnected && document.activeElement === guideTarget.current
      const outsideInput = editing(document.activeElement) && !own?.contains(document.activeElement) && !guidedFocus
      const blocked = consoleOpen || modalOpen || outsideInput
      active.current.suppressed = blocked
      setSuppressed(previous => previous === blocked ? previous : blocked)
      setHardSuppressed(previous => previous === (consoleOpen || modalOpen) ? previous : consoleOpen || modalOpen)
      const root=document.getElementById('main-content'),currentGuide=guideState.current
      // A target can become ambiguous after it was selected. Recheck the exact
      // current-step anchor, not merely the retained element's visibility.
      const targetInvalid = guideTarget.current && (!currentGuide || !(root instanceof HTMLElement)
        || findGuideTarget(root,currentGuide.definition.steps[currentGuide.index])!==guideTarget.current)
      if (blocked && active.current.mode !== 'closed') close(false)
      else if (targetInvalid) unavailableGuideTarget()
    }
    const schedule = () => {if (!layoutRequest) layoutRequest = requestAnimationFrame(inspect)}
    const relevant = (node: Node) => node instanceof HTMLElement && !wrapper.current?.contains(node)
      && (node.matches(ENVIRONMENT_SELECTOR) || !!node.querySelector(ENVIRONMENT_SELECTOR) || node === guideTarget.current
        || Boolean(guideTarget.current && node.contains(guideTarget.current)))
    const observer = new MutationObserver(records => {
      if (records.some(record => !wrapper.current?.contains(record.target)
        && ((active.current.mode==='guide' && record.target instanceof Element && Boolean(record.target.closest('#main-content')))
          || (record.type === 'attributes' ? relevant(record.target)
          || (record.attributeName === 'open' && record.target instanceof HTMLDialogElement)
          || (record.target instanceof Element && !!record.target.closest('.game-console'))
          : [...record.addedNodes, ...record.removedNodes].some(relevant))))) schedule()
    })
    observer.observe(document.body, {childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'open', 'aria-hidden', 'aria-modal', 'aria-disabled', 'aria-busy', 'disabled', 'inert', 'role', 'style', 'data-guide-anchor']})
    const focused = (event: FocusEvent) => {
      const guidedFocus = active.current.mode === 'guide' && guideIdentity.current === active.current.identity && event.target === guideTarget.current && guideTarget.current?.isConnected
      if (event.target instanceof Element && !wrapper.current?.contains(event.target) && active.current.mode !== 'closed') {
        const modal = event.target.closest<HTMLElement>(MODAL_SELECTOR)
        // Native dialogs may open and close before the next layout frame.
        // Their focus event records the interruption immediately.
        if ((modal && visible(modal)) || (editing(event.target) && !guidedFocus)) close(false)
      }
      schedule()
    }
    document.addEventListener('focusin', focused)
    document.addEventListener('focusout', schedule)
    window.addEventListener('resize', schedule)
    inspect()
    return () => {
      observer.disconnect()
      if (layoutRequest) cancelAnimationFrame(layoutRequest)
      document.removeEventListener('focusin', focused); document.removeEventListener('focusout', schedule)
      window.removeEventListener('resize', schedule)
    }
  }, [close, unavailableGuideTarget])

  const changePreference = (key: keyof SpiritPreferences, checked: boolean) => {
    const next = {...preferenceRef.current, [key]: checked}
    preferenceRef.current = next; active.current.energy = next.energy; active.current.instantText = next.instantText
    setPreferences(next); writeSpiritPreferences(next)
    if (key === 'energy') cancelMotion(true)
    else stopText(true)
  }
  if (typeof document === 'undefined') return null
  const style = {'--page-spirit-accent': character.accent, '--page-spirit-backdrop': character.backdropColor || 'transparent'} as CSSProperties
  const availableGuide = packIdentity.current === identity ? getSpiritGuide(pageId, currentTopic.current) : null
  const currentGuide = mode === 'guide' && guide?.identity === identity ? guide : null
  const topicMetadata = packIdentity.current === identity ? pack?.topics.find(topic => topic.id === currentTopic.current) : null
  const guideOptions = packIdentity.current === identity ? (pack?.topics ?? []).flatMap(topic => {
    const definition = getSpiritGuide(pageId, topic.id)
    return definition?.steps.length ? [{topicId: topic.id, definition}] : []
  }) : []
  const controlsDisabled = disabled || hardSuppressed
  return <div ref={wrapper} className="page-spirit-widget" style={style} role="region" aria-labelledby={`${uid}-name ${uid}-page`}
    data-page-id={pageId} data-open={open} data-mode={mode} data-inline="true" data-quiet={disabled || suppressed}
    data-load-state={loadState} data-canonical-count={canonical.current.length}
    onKeyDown={event => {
      if (event.key === 'Escape' && mode !== 'closed' && !composing.current && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
        event.preventDefault(); event.stopPropagation(); close(true)
      }
    }}>
    <div className="page-spirit-presence">
      <button ref={launcher} type="button" className="page-spirit-launcher" disabled={controlsDisabled} onClick={event => begin(event.currentTarget)}
        aria-label={`${character.name}・${character.title}的當頁${label}`} aria-expanded={questionsOpen} aria-controls={`${uid}-questions`}>
        <span className="page-spirit-portrait" aria-hidden="true" data-animating={sprite.identity === identity && sprite.playing} data-frame-index={sprite.identity === identity ? sprite.index : 'hero'}>
          <img className="page-spirit-art" src={sprite.identity === identity ? sprite.src : character.hero} width="96" height="144" alt="" decoding="async" onLoad={event => {event.currentTarget.hidden = false}} onError={event => {event.currentTarget.hidden = true}}/>
        </span>
      </button>
      <div className="page-spirit-presence-copy">
        <div className="page-spirit-nameplate"><strong id={`${uid}-name`}>{character.name}</strong><span id={`${uid}-page`}>{character.title}</span></div>
        <p className="page-spirit-brief">{disabled || hardSuppressed ? '先專心操作，想問時再叫我。' : '我在這一頁陪你看。'}</p>
      </div>
      <div className="page-spirit-entry-actions">
        <button ref={compactContinue} type="button" className="page-spirit-button page-spirit-primary" disabled={controlsDisabled} aria-expanded={questionsOpen} aria-controls={`${uid}-questions`} onClick={event => begin(event.currentTarget)}>{mode === 'compact' ? '繼續交談' : '問本頁'}</button>
        <button type="button" className="page-spirit-button" disabled={controlsDisabled} aria-expanded={guideMenuOpen} aria-controls={`${uid}-guides`} onClick={event => begin(event.currentTarget, 'guides')}>帶我看</button>
      </div>
    </div>

    {guideMenuOpen && <details id={`${uid}-guides`} className="page-spirit-disclosure page-spirit-guide-directory" open>
      <summary onClick={event => {event.preventDefault(); close(true)}}>選一個本頁入口</summary>
      <div className="page-spirit-disclosure-body">
        {loadState === 'loading' && <p className="page-spirit-note">正在準備這一頁的指引。</p>}
        {loadState === 'error' && <button type="button" className="page-spirit-button" onClick={() => void loadPack()}>重新讀取本頁說明</button>}
        {loadState === 'ready' && <div className="page-spirit-guide-options" aria-label="本頁指引目錄">
          {guideOptions.map(option => <button type="button" className="page-spirit-option" key={option.topicId} aria-label={option.definition.label} onClick={() => chooseGuide(option.topicId)}>{option.definition.label}</button>)}
          {!guideOptions.length && <p className="page-spirit-note">這一頁先用問題陪你看。可以點「問本頁」選一題。</p>}
        </div>}
      </div>
    </details>}

    {currentGuide && <section className="page-spirit-guide" aria-label="當頁操作指引" data-guide-step={currentGuide.index + 1} data-guide-found={currentGuide.found}>
      <p className="page-spirit-guide-count">指引 {currentGuide.index + 1}/{currentGuide.definition.steps.length}</p>
      <p className="page-spirit-guide-instruction">{currentGuide.definition.steps[currentGuide.index].instruction}</p>
      {!currentGuide.found && <p className="page-spirit-note">這個入口目前無法使用，請先查看本頁提示。</p>}
      <div className="page-spirit-guide-actions">
        {!currentGuide.found && <button type="button" className="page-spirit-button" onClick={() => moveGuide(currentGuide.definition, currentGuide.index)}>重找入口</button>}
        {currentGuide.found && currentGuide.index + 1 < currentGuide.definition.steps.length && <button type="button" className="page-spirit-button" onClick={() => moveGuide(currentGuide.definition, currentGuide.index + 1)}>下一步</button>}
        <button type="button" className="page-spirit-button" onClick={event => begin(event.currentTarget)}>繼續交談</button>
        <button type="button" className="page-spirit-button" onClick={() => close(true)}>結束指引</button>
      </div>
    </section>}

    {questionsOpen && <details id={`${uid}-questions`} className="page-spirit-disclosure page-spirit-question-disclosure" open>
      <summary onClick={event => {event.preventDefault(); minimize()}}>本頁說明</summary>
      <section ref={content} className="page-spirit-panel" aria-label={`${character.name}的本頁說明`}>
        <div className="page-spirit-panel-actions">
          <button type="button" className="page-spirit-button" onClick={minimize}>收合交談</button>
          <button ref={closeButton} type="button" className="page-spirit-button" onClick={() => close(true)}>結束交談</button>
        </div>
        <div className="page-spirit-content">
          <div className="page-spirit-line" aria-hidden="true" data-typing={typing}><p>{lineIdentity.current === identity ? line : ''}</p></div>
          {typing && <button ref={showFullButton} type="button" className="page-spirit-button page-spirit-skip" onClick={() => {stopText(true); closeButton.current?.focus({preventScroll: true})}}>顯示全文</button>}
          {loadState === 'error' && <button type="button" className="page-spirit-button" onClick={() => void loadPack()}>重新讀取本頁說明</button>}
          {loadState === 'ready' && packIdentity.current === identity && <>
            {availableGuide && <button type="button" className="page-spirit-button page-spirit-guide-button" onClick={startGuide}>{availableGuide.label}</button>}
            <details className="page-spirit-faq"><summary>可以問這些問題</summary>
              <div className="page-spirit-topics" aria-label="本頁交談選項">{pack?.topics.map((topic: SpiritPack['topics'][number]) => <button type="button" className="page-spirit-option" key={topic.id} aria-label={topic.label} onClick={() => ask(topic.label, topic.id)}>{topic.label}</button>)}</div>
            </details>
            <details className="page-spirit-history"><summary>剛才的說明</summary><div className="page-spirit-response-tools">
              <button type="button" className="page-spirit-button" aria-disabled={historyPosition <= 0} onClick={previous}>上一句</button>
              {historyPosition < canonical.current.length - 1 && <button type="button" className="page-spirit-button" onClick={latest}>回到最新</button>}
              <button type="button" className="page-spirit-button" onClick={restart}>重新開始</button>
            </div></details>
          </>}
        </div>
        <form className="page-spirit-form" onSubmit={submit}>
          <label htmlFor={`${uid}-input`} className="page-spirit-sr">問本頁問題</label>
          <input ref={questionInput} id={`${uid}-input`} value={packIdentity.current === identity ? question : ''} onChange={event => setQuestion(event.target.value)} maxLength={240} autoComplete="off"
            onCompositionStart={() => {composing.current = true}} onCompositionEnd={() => {composing.current = false}}
            onKeyDown={event => {if (event.key === 'Enter' && (composing.current || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)) event.preventDefault()}}
            placeholder={pack?.topics[0] && packIdentity.current === identity ? `例如：我想了解${pack.topics[0].label}` : '或寫下你想問的事'} disabled={loadState !== 'ready' || packIdentity.current !== identity}/>
          <button className="page-spirit-button page-spirit-primary" type="submit" disabled={loadState !== 'ready' || packIdentity.current !== identity || !question.trim()}>送出</button>
        </form>
        {topicMetadata?.nextStep && <p className="page-spirit-follow-up">也可以問：下一步呢</p>}
        <details className="page-spirit-preferences"><summary>陪伴偏好</summary><div>
          <label><input type="checkbox" checked={preferences.energy} onChange={event => changePreference('energy', event.target.checked)}/>靜態省電</label>
          <label><input type="checkbox" checked={preferences.instantText} onChange={event => changePreference('instantText', event.target.checked)}/>直接顯示全文</label>
        </div></details>
        <button type="button" className="page-spirit-button page-spirit-art-link" onClick={() => {cancelMotion(true); setGalleryOpen(true)}}>角色六視圖</button>
      </section>
    </details>}
    <p className="page-spirit-sr" role="status" aria-live="polite" aria-atomic="true"><span key={announcementRevision}>{lineIdentity.current === identity || currentGuide ? announcement : ''}</span></p>
    {galleryOpen && <GuideGallery characters={gallery} label={label} initial={pageId} onClose={() => setGalleryOpen(false)}/>}
  </div>
}
