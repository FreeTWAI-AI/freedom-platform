import {useCallback, useEffect, useId, useRef, useState, type CSSProperties, type FormEvent} from 'react'
import {createPortal} from 'react-dom'
import type {TabId} from '../../types'
import {SPIRIT_CHARACTERS} from './catalog'
import {loadSpiritPack} from './packs'
import {createPageSession, type SpiritPack} from './core'
import './page-spirit.css'

type Props = {pageId: TabId; scopeKey: string; disabled?: boolean}
type SpiritState = 'idle' | 'wave' | 'think' | 'cheer' | 'calm' | 'sleep'
type LoadState = 'idle' | 'loading' | 'ready' | 'error'
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

export function PageSpirit({pageId, scopeKey, disabled = false}: Props) {
  const character = SPIRIT_CHARACTERS[pageId]
  const identity = `${scopeKey}:${pageId}`
  const uid = useId()
  const wrapper = useRef<HTMLDivElement>(null)
  const launcher = useRef<HTMLButtonElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const questionInput = useRef<HTMLInputElement>(null)
  const mounted = useRef(false)
  const active = useRef({identity, open: false, disabled, suppressed: false, energy: false, reduced: false})
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
  const [open, setOpen] = useState(false)
  const [suppressed, setSuppressed] = useState(false)
  const [loadState, setLoadState] = useState<LoadState>('idle')
  const [pack, setPack] = useState<SpiritPack | null>(null)
  const [question, setQuestion] = useState('')
  const [line, setLine] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const [typing, setTyping] = useState(false)
  const [energy, setEnergy] = useState(false)
  const [sprite, setSprite] = useState<{src: string; index: number | 'hero'; playing: boolean; identity: string}>({src: character.hero, index: 'hero', playing: false, identity})
  const [geometry, setGeometry] = useState({bottom: 64, maxHeight: 560})

  const permitted = useCallback((expectedIdentity: string) => mounted.current && active.current.identity === expectedIdentity
    && active.current.open && !active.current.disabled && !active.current.suppressed && !document.hidden, [])
  const motionPermitted = useCallback((expectedIdentity: string) => permitted(expectedIdentity)
    && !active.current.energy && !active.current.reduced, [permitted])

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
    active.current.open = false
    packEpoch.current++
    cancelMotion(!clear)
    forgetFrames()
    if (mounted.current) {
      setOpen(false); setQuestion(''); setAnnouncement('')
      if (!currentPack.current) setLoadState('idle')
    }
    if (clear) {
      session.current?.clear(); session.current = null; currentPack.current = null; packIdentity.current = ''
      fullText.current = ''; lineIdentity.current = ''; hasOpened.current = false
      if (mounted.current) {setPack(null); setLoadState('idle'); setLine('')}
    }
    if (returnFocus) focusRequest.current = requestAnimationFrame(() => {
      focusRequest.current = 0
      if (mounted.current && !active.current.open && !active.current.disabled && !active.current.suppressed) launcher.current?.focus({preventScroll: true})
    })
  }, [cancelMotion, forgetFrames])

  const showLine = useCallback((text: string) => {
    stopText(false)
    fullText.current = text
    lineIdentity.current = active.current.identity
    setAnnouncement(text)
    const characters = Array.from(text)
    const expectedIdentity = active.current.identity
    if (!motionPermitted(expectedIdentity) || characters.length <= 1) {setLine(text); return}
    const generation = textGeneration.current, start = performance.now()
    const duration = Math.min(3000, characters.length / 30 * 1000)
    let count = 1
    setLine(characters[0]); setTyping(true)
    const step = (time: number) => {
      if (generation !== textGeneration.current || !mounted.current || active.current.identity !== expectedIdentity) return
      textRequest.current = 0
      const elapsed = time - start
      if (!motionPermitted(expectedIdentity) || elapsed >= duration) {stopText(true); return}
      const next = Math.max(1, Math.floor(Math.max(0, elapsed) / duration * characters.length))
      if (next !== count) {count = next; setLine(characters.slice(0, next).join(''))}
      textRequest.current = requestAnimationFrame(step)
    }
    textRequest.current = requestAnimationFrame(step)
  }, [motionPermitted, stopText])

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
      const loaded = await loadSpiritPack(expectedPage)
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
      showLine('這一頁的說明暫時沒載入。再試一次，我會留在這一頁。')
    }
  }, [pageId, permitted, playSprite, showLine, stopText])

  const begin = useCallback(() => {
    if (active.current.disabled || active.current.suppressed || document.hidden) return
    active.current.open = true
    setOpen(true)
    if (currentPack.current && session.current && packIdentity.current === active.current.identity) {
      showLine(hasOpened.current ? fullText.current || currentPack.current.entryLine : currentPack.current.entryLine)
      hasOpened.current = true; playSprite()
    } else void loadPack()
    focusRequest.current = requestAnimationFrame(() => {
      focusRequest.current = 0
      if (permitted(active.current.identity)) closeButton.current?.focus({preventScroll: true})
    })
  }, [loadPack, permitted, playSprite, showLine])

  const ask = useCallback((input: string, topicId?: string) => {
    if (!session.current || !currentPack.current || packIdentity.current !== active.current.identity || !permitted(active.current.identity)) return
    const result = session.current.ask(input, topicId)
    setQuestion(''); showLine(result.text)
    const state = result.state as SpiritState
    if (state === 'wave' || state === 'think' || state === 'cheer') playSprite()
    else stopSprite()
  }, [permitted, playSprite, showLine, stopSprite])
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const text = question.trim()
    if (text) ask(text)
  }

  useEffect(() => {
    mounted.current = true
    close(false, true)
    return () => {
      mounted.current = false; active.current.open = false; packEpoch.current++
      cancelMotion(false); forgetFrames(); session.current?.clear(); session.current = null; currentPack.current = null; packIdentity.current = ''
      fullText.current = ''; lineIdentity.current = ''
    }
  }, [identity, cancelMotion, close, forgetFrames])

  useEffect(() => {if (disabled) close(false, true)}, [disabled, close])
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    active.current.reduced = media.matches
    const changed = () => {active.current.reduced = media.matches; cancelMotion(true)}
    const visibility = () => {if (document.hidden) close(false)}
    const sessionEnded = () => close(false, true)
    media.addEventListener('change', changed)
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('freedom-game-console-session-end', sessionEnded)
    return () => {
      media.removeEventListener('change', changed)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('freedom-game-console-session-end', sessionEnded)
    }
  }, [cancelMotion, close])

  useEffect(() => {
    let layoutRequest = 0
    const consoleElements = new Set<HTMLElement>()
    const inspect = () => {
      layoutRequest = 0
      const own = wrapper.current
      const consoles = Array.from(document.querySelectorAll<HTMLElement>('.game-console')).filter(element => !own?.contains(element))
      for (const element of consoleElements) if (!consoles.includes(element)) {resize?.unobserve(element); consoleElements.delete(element)}
      for (const element of consoles) if (!consoleElements.has(element)) {consoleElements.add(element); resize?.observe(element)}
      const consoleOpen = consoles.some(element => element.classList.contains('game-console-expanded') && visible(element))
      const modalOpen = Array.from(document.querySelectorAll<HTMLElement>(MODAL_SELECTOR)).some(element => !own?.contains(element) && visible(element))
      const outsideInput = editing(document.activeElement) && !own?.contains(document.activeElement)
      const blocked = consoleOpen || modalOpen || outsideInput
      active.current.suppressed = blocked
      setSuppressed(previous => previous === blocked ? previous : blocked)
      if (blocked && active.current.open) close(false)
      const viewport = window.visualViewport
      const keyboard = Math.max(0, window.innerHeight - ((viewport?.height ?? window.innerHeight) + (viewport?.offsetTop ?? 0)))
      const consoleBottom = consoles.filter(visible).reduce((bottom, element) => Math.max(bottom, window.innerHeight - element.getBoundingClientRect().top + 12), 12)
      const bottom = Math.ceil(Math.max(consoleBottom, keyboard + 12))
      const maxHeight = Math.max(160, Math.floor((viewport?.height ?? window.innerHeight) - (bottom - keyboard) - 24))
      setGeometry(previous => previous.bottom === bottom && previous.maxHeight === maxHeight ? previous : {bottom, maxHeight})
    }
    const schedule = () => {if (!layoutRequest) layoutRequest = requestAnimationFrame(inspect)}
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    const relevant = (node: Node) => node instanceof HTMLElement && !wrapper.current?.contains(node)
      && (node.matches(ENVIRONMENT_SELECTOR) || !!node.querySelector(ENVIRONMENT_SELECTOR))
    const observer = new MutationObserver(records => {
      if (records.some(record => !wrapper.current?.contains(record.target)
        && (record.type === 'attributes' ? relevant(record.target)
          || (record.attributeName === 'open' && record.target instanceof HTMLDialogElement)
          || (record.target instanceof Element && !!record.target.closest('.game-console'))
          : [...record.addedNodes, ...record.removedNodes].some(relevant)))) schedule()
    })
    observer.observe(document.body, {childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'open', 'aria-hidden', 'aria-modal', 'role', 'style']})
    const focused = (event: FocusEvent) => {
      if (event.target instanceof Element && !wrapper.current?.contains(event.target) && editing(event.target) && active.current.open) close(false)
      schedule()
    }
    document.addEventListener('focusin', focused)
    document.addEventListener('focusout', schedule)
    window.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('resize', schedule)
    window.visualViewport?.addEventListener('scroll', schedule)
    inspect()
    return () => {
      observer.disconnect(); resize?.disconnect()
      if (layoutRequest) cancelAnimationFrame(layoutRequest)
      document.removeEventListener('focusin', focused); document.removeEventListener('focusout', schedule)
      window.removeEventListener('resize', schedule)
      window.visualViewport?.removeEventListener('resize', schedule); window.visualViewport?.removeEventListener('scroll', schedule)
    }
  }, [close])

  const changeEnergy = (checked: boolean) => {
    active.current.energy = checked; setEnergy(checked); cancelMotion(true)
  }
  if (disabled || suppressed || typeof document === 'undefined') return null
  const style = {
    '--page-spirit-accent': character.accent,
    '--page-spirit-backdrop': character.backdropColor || '#f1f3f5',
    '--page-spirit-bottom': `${geometry.bottom}px`,
    '--page-spirit-max-height': `${geometry.maxHeight}px`,
  } as CSSProperties
  return createPortal(<div ref={wrapper} className="page-spirit-widget" style={style} data-page-id={pageId} data-open={open} data-load-state={loadState} data-compact={geometry.maxHeight < 280}>
    <button ref={launcher} type="button" className="page-spirit-launcher" hidden={open} onClick={begin}
      aria-label={`${character.name}・${character.title}的當頁龍娘`} aria-haspopup="dialog" aria-expanded={open} aria-controls={`${uid}-dialog`}>
      <img src={character.portrait} width="64" height="64" alt="" decoding="async"/>
    </button>
    {open && <section id={`${uid}-dialog`} className="page-spirit-panel" role="dialog" aria-modal={false} aria-labelledby={`${uid}-name`}
      onKeyDown={event => {if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); close(true)}}}>
      <header className="page-spirit-header">
        <div className="page-spirit-nameplate"><strong id={`${uid}-name`}>{character.name}</strong><span>{character.title}</span></div>
        <button ref={closeButton} type="button" className="page-spirit-button page-spirit-close" onClick={() => close(true)}>結束交談</button>
      </header>
      <div className="page-spirit-content">
        <div className="page-spirit-portrait" aria-hidden="true" data-animating={sprite.identity === identity && sprite.playing} data-frame-index={sprite.identity === identity ? sprite.index : 'hero'}>
          <img className="page-spirit-art" src={sprite.identity === identity ? sprite.src : character.hero} width="384" height="576" alt="" decoding="async"/>
        </div>
        <div className="page-spirit-dialogue">
          <div className="page-spirit-line" aria-hidden="true" data-typing={typing}><p>{lineIdentity.current === identity ? line : ''}</p></div>
          <p className="page-spirit-sr" role="status" aria-live="polite" aria-atomic="true">{lineIdentity.current === identity ? announcement : ''}</p>
          {typing && <button type="button" className="page-spirit-button page-spirit-skip" onClick={() => {stopText(true); closeButton.current?.focus({preventScroll: true})}}>顯示全文</button>}
          {loadState === 'error' && <button type="button" className="page-spirit-button" onClick={() => void loadPack()}>重新讀取本頁說明</button>}
          {loadState === 'ready' && pack && packIdentity.current === identity && <>
            <p className="page-spirit-prompt">想問這一頁的哪件事？</p>
            <div className="page-spirit-topics" aria-label="本頁交談選項">{pack.topics.map((topic: SpiritPack['topics'][number]) => <button type="button" className="page-spirit-option" key={topic.id} aria-label={topic.label} onClick={() => ask(topic.label, topic.id)}>{topic.label}</button>)}</div>
          </>}
        </div>
      </div>
      <footer className="page-spirit-footer">
        <form className="page-spirit-form" onSubmit={submit}>
          <label htmlFor={`${uid}-input`} className="page-spirit-sr">問本頁問題</label>
          <input ref={questionInput} id={`${uid}-input`} value={packIdentity.current === identity ? question : ''} onChange={event => setQuestion(event.target.value)} maxLength={240} autoComplete="off"
            placeholder="或寫下你想問的事" disabled={loadState !== 'ready' || packIdentity.current !== identity}/>
          <button className="page-spirit-button page-spirit-primary" type="submit" disabled={loadState !== 'ready' || packIdentity.current !== identity || !question.trim()}>送出</button>
        </form>
        <div className="page-spirit-tools"><label><input type="checkbox" checked={energy} onChange={event => changeEnergy(event.target.checked)}/>靜態省電</label>
          <a href={`/page-spirit-characters.html#${pageId}`} target="_blank" rel="noopener noreferrer">角色六視圖</a></div>
      </footer>
    </section>}
  </div>, document.body)
}
