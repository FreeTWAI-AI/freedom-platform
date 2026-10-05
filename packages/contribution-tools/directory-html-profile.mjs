// Fixed host HTML5 profile. HTML is parsed as data; no browser or candidate code.
import { parse } from './directory-html-host/node_modules/parse5/dist/index.js';
import { readSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const DIRECTORY_HTML_PROFILE = 'freedom.directory-html/v2';
const HTML = 'http://www.w3.org/1999/xhtml';
const allowedTags = new Set(('html head meta title style body main header footer nav section article div span p '
  + 'h1 h2 h3 h4 h5 h6 a ul ol li dl dt dd strong em b i small br hr code pre blockquote time abbr address '
  + 'figure figcaption table thead tbody tfoot tr th td caption colgroup col').split(' '));
const globalAttributes = new Set(['id', 'class', 'style', 'title', 'lang', 'dir', 'role', 'tabindex', 'hidden']);
const textBlocks = new Set(('main header footer nav section article div p h1 h2 h3 h4 h5 h6 ul ol li dl dt dd '
  + 'pre blockquote address figure figcaption table tr th td caption').split(' '));
const normalize = value => value.replace(/\s+/gu, ' ').trim();
const requireValue = (condition, code) => { if (!condition) throw Error(code); };
const attr = (node, name) => node.attrs?.find(item => item.name === name)?.value;

function csp(value) {
  const directives = new Map();
  for (const raw of value.split(';').map(item => item.trim()).filter(Boolean)) {
    const [name, ...sources] = raw.split(/\s+/u);
    requireValue(!directives.has(name), 'directory_csp');
    directives.set(name, sources);
  }
  for (const [key, value] of [['default-src', "'none'"], ['style-src', "'unsafe-inline'"], ['base-uri', "'none'"], ['form-action', "'none'"]])
    requireValue(JSON.stringify(directives.get(key)) === JSON.stringify([value]), 'directory_csp');
  for (const [key, sources] of directives) {
    if (['default-src', 'style-src', 'base-uri', 'form-action'].includes(key)) continue;
    requireValue(['script-src', 'object-src', 'connect-src', 'img-src', 'font-src', 'media-src', 'frame-src', 'worker-src', 'manifest-src'].includes(key)
      && JSON.stringify(sources) === JSON.stringify(["'none'"]), 'directory_csp');
  }
}

function inspectDocument(html) {
  requireValue(typeof html === 'string' && html.isWellFormed() && Buffer.byteLength(html) <= 2 * 1024 * 1024, 'directory_html_size');
  const document = parse(html, { scriptingEnabled: true, onParseError: () => { throw Error('directory_html_parse'); } });
  const nodes = [], elements = [], ids = new Map(), stack = [[document, 0, null, false]];
  let body, head;
  while (stack.length) {
    const [node, depth, language, hidden] = stack.pop();
    requireValue(nodes.length < 20000 && depth <= 128, 'directory_html_complexity');
    nodes.push(node);
    node.profileLang = attr(node, 'lang') ?? language;
    node.profileHidden = hidden || attr(node, 'hidden') !== undefined || attr(node, 'aria-hidden') === 'true';
    if (node.tagName) {
      requireValue(node.namespaceURI === HTML && allowedTags.has(node.tagName), 'directory_html_element');
      requireValue(node.attrs.length <= 32, 'directory_html_attributes');
      elements.push(node);
      if (node.tagName === 'head') head = node;
      if (node.tagName === 'body') body = node;
      for (const item of node.attrs) {
        requireValue(!item.namespace && !item.prefix && item.value.length <= 4096, 'directory_html_attributes');
        const allowed = globalAttributes.has(item.name) || /^aria-[a-z-]+$/.test(item.name) || /^data-[a-z0-9-]+$/.test(item.name)
          || node.tagName === 'a' && ['href', 'rel', 'target'].includes(item.name)
          || node.tagName === 'meta' && ['charset', 'name', 'content', 'http-equiv'].includes(item.name)
          || ['td', 'th'].includes(node.tagName) && ['colspan', 'rowspan', 'scope', 'headers'].includes(item.name)
          || node.tagName === 'time' && item.name === 'datetime';
        requireValue(allowed, 'directory_html_attributes');
      }
      const id = attr(node, 'id');
      if (id !== undefined) {
        requireValue(id.length > 0 && !/[\s\u0000-\u001f]/u.test(id) && !ids.has(id), 'directory_html_id');
        ids.set(id, node);
      }
    }
    for (const child of [...(node.childNodes ?? [])].reverse()) stack.push([child, depth + 1, node.profileLang, node.profileHidden]);
  }
  requireValue(body && head, 'directory_html_document');
  const headElements = elements.filter(node => node.parentNode === head);
  const policies = elements.filter(node => node.tagName === 'meta' && attr(node, 'http-equiv')?.toLowerCase() === 'content-security-policy');
  requireValue(policies.length === 1 && policies[0].parentNode === head, 'directory_csp');
  csp(attr(policies[0], 'content') ?? '');
  for (const node of elements) {
    if (['meta', 'style', 'title'].includes(node.tagName)) requireValue(node.parentNode === head, 'directory_html_head');
    if (node.tagName === 'style') requireValue(headElements.indexOf(policies[0]) < headElements.indexOf(node), 'directory_csp_order');
    if (node.tagName === 'meta') {
      if (attr(node, 'charset') !== undefined) requireValue(attr(node, 'charset').toLowerCase() === 'utf-8', 'directory_html_charset');
      if (attr(node, 'name')?.toLowerCase() === 'referrer') requireValue(attr(node, 'content') === 'no-referrer', 'directory_html_referrer');
      requireValue(attr(node, 'charset')?.toLowerCase() === 'utf-8'
        || ['viewport', 'referrer', 'description'].includes(attr(node, 'name')?.toLowerCase())
        || node === policies[0], 'directory_html_meta');
      if (attr(node, 'http-equiv') !== undefined) requireValue(node === policies[0], 'directory_html_meta');
    }
    if (node.tagName === 'a') {
      requireValue(attr(node, 'href') !== undefined && !/[\u0000-\u0020\u007f]/u.test(attr(node, 'href')), 'directory_html_url');
      try { node.profileHref = decodeURIComponent(attr(node, 'href')); }
      catch { throw Error('directory_html_url'); }
      requireValue(!/[\u0000-\u001f\u007f]/u.test(node.profileHref), 'directory_html_url');
      requireValue(attr(node, 'target') === undefined || ['_self', '_blank'].includes(attr(node, 'target')), 'directory_html_target');
      if (attr(node, 'target') === '_blank' || attr(node, 'href').startsWith('https:')) {
        const rel = new Set((attr(node, 'rel') ?? '').toLowerCase().split(/\s+/u));
        requireValue(rel.has('noopener') && rel.has('noreferrer'), 'directory_html_rel');
      }
    }
    for (const key of ['aria-labelledby', 'aria-describedby', 'aria-controls', 'headers']) {
      const references = attr(node, key);
      if (references !== undefined) requireValue(references.trim() && references.trim().split(/\s+/u).every(id => ids.has(id)), 'directory_html_reference');
    }
  }
  requireValue(elements.some(node => node.tagName === 'meta' && attr(node, 'charset')?.toLowerCase() === 'utf-8'), 'directory_html_charset');
  requireValue(elements.some(node => node.tagName === 'meta' && attr(node, 'name')?.toLowerCase() === 'referrer' && attr(node, 'content') === 'no-referrer'), 'directory_html_referrer');
  const inBody = node => { for (let current = node; current; current = current.parentNode) if (current === body) return true; return false; };
  const contentElements = elements.filter(node => inBody(node) && !node.profileHidden);
  // Text comes from the HTML5 tree, not raw substrings or attributes. Wrappers
  // and decorative aria-hidden nodes do not alter the public data projection.
  const text = node => {
    if (node.profileHidden) return '';
    if (node.nodeName === '#text') return node.value;
    if (node.tagName === 'br') return ' ';
    return (node.childNodes ?? []).map(child => textBlocks.has(child.tagName) ? ' ' + text(child) + ' ' : text(child)).join('');
  };
  const hasText = (within, value, language) => {
    if (!normalize(value)) return true;
    return contentElements.some(node => (!language || node.profileLang === language) && contains(within, node)
      && normalize(text(node)) === normalize(value));
  };
  return { elements: contentElements, links: elements.filter(node => inBody(node) && node.tagName === 'a'), ids, body, text, hasText };
}
function contains(parent, node) {
  for (let current = node; current; current = current.parentNode) if (current === parent) return true;
  return false;
}
function inputLinks(input) {
  const values = [];
  for (const language of [input.zh, input.en]) for (const section of language.sections)
    for (const block of section.blocks) values.push(...(block.ul ?? [block.p]));
  const links = new Set();
  // The fixed public text linkification contract. This examines input text, not
  // HTML, and never treats markup or a candidate-supplied URL list as authority.
  for (const value of values) {
    for (const match of value.matchAll(/https:\/\/[A-Za-z0-9.\-]+(?:\/[A-Za-z0-9._~\-\/]*)?/g)) links.add(match[0].replace(/[.]+$/, ''));
    for (const match of value.matchAll(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g)) links.add('mailto:' + match[0]);
  }
  return links;
}

export function verifyDirectoryHtml(kind, html, input) {
  const tree = inspectDocument(html), links = tree.links;
  if (kind === 'directory') {
    const expected = new Map(input.projects.map(project => ['https://github.com/' + input.organization + '/' + project.repository, project]));
    const seen = new Set(); let privacy = 0;
    for (const link of links) {
      const href = attr(link, 'href');
      if (href === 'privacy/discord-bot/') { requireValue(!link.profileHidden, 'directory_html_url'); privacy++; continue; }
      if (href.startsWith('#')) { requireValue(tree.ids.has(link.profileHref.slice(1)), 'directory_html_fragment'); continue; }
      const project = expected.get(href);
      requireValue(project && !seen.has(href) && !link.profileHidden, 'directory_html_url');
      seen.add(href);
      let container = link.parentNode, found = false;
      while (container) {
        const projectLinks = links.filter(item => expected.has(attr(item, 'href')) && contains(container, item));
        if (projectLinks.length === 1 && ['name', 'description', 'scope'].every(key => tree.hasText(container, project[key]))) { found = true; break; }
        container = container.parentNode;
      }
      requireValue(found, 'directory_public_data');
    }
    requireValue(seen.size === expected.size && privacy === 1, 'directory_public_data');
  } else {
    requireValue(kind === 'privacy', 'directory_html_kind');
    const expected = inputLinks(input), seen = new Set();
    for (const link of links) {
      const href = attr(link, 'href');
      if (href.startsWith('#')) requireValue(tree.ids.has(link.profileHref.slice(1)), 'directory_html_fragment');
      else { requireValue(expected.has(href) && !link.profileHidden, 'directory_html_url'); seen.add(href); }
    }
    requireValue([...expected].every(href => seen.has(href)), 'directory_public_data');
    for (const [key, language] of [['zh', 'zh-Hant'], ['en', 'en']]) {
      const data = input[key];
      const values = [data.title, data.effective, data.eyebrow ?? ''];
      for (const section of data.sections) {
        values.push(section.h);
        for (const block of section.blocks) values.push(...(block.ul ?? [block.p]));
      }
      requireValue(values.every(value => tree.hasText(tree.body, value, language)), 'directory_public_data');
    }
  }
  return { status: 'passed', profile: DIRECTORY_HTML_PROFILE };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const buffers = []; let bytes = 0;
    for (;;) {
      const buffer = Buffer.alloc(65536), count = readSync(0, buffer, 0, buffer.length);
      if (!count) break;
      requireValue((bytes += count) <= 8 * 1024 * 1024, 'directory_html_size');
      buffers.push(buffer.subarray(0, count));
    }
    const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(buffers)));
    console.log(JSON.stringify(verifyDirectoryHtml(input.kind, input.html, input.data)));
  } catch (error) {
    console.log(JSON.stringify({ status: 'failed', reason: /^directory_[a-z_]+$/.test(error.message) ? error.message : 'directory_html_invalid' }));
    process.exitCode = 1;
  }
}
