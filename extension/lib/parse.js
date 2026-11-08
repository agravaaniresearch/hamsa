// Parses a rendered HN item page (a DOM document) into a flat, structured list.
// Works on any DOM: linkedom in Node, the live `document` inside a browser extension.
import { DEFAULTS } from './config.js';

// HN fades downvoted comments through these text-colour classes (from HN Companion).
const DOWNVOTE_MAP = {
  c00: 0, c5a: 1, c73: 2, c82: 3, c88: 4, c9c: 5, cae: 6, cbe: 7, cce: 8, cdd: 9,
};

const trunc = (s, n) => (s.length > n ? s.slice(0, n).trimEnd() + ' […]' : s);

function shortUrl(href, cfg) {
  return trunc(href.replace(/^https?:\/\/(www\.)?/, ''), cfg.urlMaxChars);
}

// Converts a comment body to plain text. Unlike HN Companion, links and code are kept,
// because they are the evidence a reader cares about.
function bodyToText(root, cfg) {
  const ctx = { links: [], hasCode: false };
  const walk = (node) => {
    if (node.nodeType === 3) return node.textContent;
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    const kids = () => [...node.childNodes].map(walk).join('');
    switch (tag) {
      case 'p': return '\n\n' + kids();
      case 'br': return '\n';
      case 'i': case 'em': return '*' + kids() + '*';
      case 'a': {
        const href = node.getAttribute('href') || '';
        const label = node.textContent || '';
        if (!/^https?:/i.test(href)) return label;
        ctx.links.push(href);
        // HN truncates the visible label of long URLs, so show the real href instead.
        const looksLikeUrl = /^https?:/i.test(label) || label.endsWith('...');
        return looksLikeUrl ? shortUrl(href, cfg) : `${label} (${shortUrl(href, cfg)})`;
      }
      case 'pre': {
        ctx.hasCode = true;
        return '\n\n```\n' + trunc(node.textContent.replace(/\s+$/, ''), cfg.codeMaxChars) + '\n```\n\n';
      }
      case 'code': ctx.hasCode = true; return '`' + node.textContent + '`';
      default: return kids();
    }
  };
  let text = [...root.childNodes].map(walk).join('');
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  text = text
    .split('\n\n')
    .map((para) => (para.startsWith('>') ? trunc(para, cfg.quoteMaxChars) : para))
    .join('\n\n');
  return { text: trunc(text, cfg.commentMaxChars), links: ctx.links, hasCode: ctx.hasCode };
}

function parseStory(doc, cfg) {
  const fat = doc.querySelector('table.fatitem');
  if (!fat) throw new Error('No story header found. Is this an HN item page?');
  const row = fat.querySelector('tr.athing');
  const titleA = fat.querySelector('.titleline > a');
  const linkUrl = titleA?.getAttribute('href') || null;
  const external = linkUrl && /^https?:/i.test(linkUrl) ? linkUrl : null;
  const topText = fat.querySelector('.toptext');
  return {
    id: Number(row?.getAttribute('id')),
    title: titleA?.textContent?.trim() || '(untitled)',
    link_url: external,
    link_domain: fat.querySelector('.sitestr')?.textContent?.trim() || null,
    author: fat.querySelector('a.hnuser, .subtext a[href^="user?id="]')?.textContent?.trim() || null,
    points: parseInt(fat.querySelector('.score')?.textContent || '0', 10) || 0,
    text: topText ? bodyToText(topText, cfg).text : null,
  };
}

export function parseThread(doc, userCfg = {}) {
  const cfg = { ...DEFAULTS, ...userCfg };
  const story = parseStory(doc, cfg);
  const rows = [...doc.querySelectorAll('tr.athing.comtr')];

  const comments = [];
  const stack = []; // {depth, path, childCount}
  let topCounter = 1;

  for (const row of rows) {
    const id = Number(row.getAttribute('id'));
    const depth = Number(row.querySelector('td.ind')?.getAttribute('indent') ?? 0);
    const comhead = row.querySelector('.comhead');
    const headText = comhead?.textContent || '';
    const textDiv = row.querySelector('.commtext');

    // Path is assigned over ALL rows so it stays stable when comments are pruned.
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack[stack.length - 1] || null;
    const path = parent ? `${parent.path}.${++parent.childCount}` : String(topCounter++);
    stack.push({ depth, path, childCount: 0 });

    let status = 'ok';
    if (/\bcoll\b|\bnoshow\b/.test(row.className || '')) status = 'collapsed';
    if (/\[(flagged|dead)\]/.test(headText)) status = 'dead';
    if (!textDiv && status === 'ok') status = 'deleted';

    const shade = [...(textDiv?.classList || [])].find((c) => /^c[0-9a-f]{2}$/.test(c));
    const body = textDiv && status === 'ok' ? bodyToText(textDiv, cfg) : { text: '', links: [], hasCode: false };

    comments.push({
      id,
      path,
      parent_path: parent ? parent.path : null,
      depth,
      author: comhead?.querySelector('a[href^="user?id="]')?.textContent || null,
      downvotes: DOWNVOTE_MAP[shade] ?? 0,
      subtree_size: Number(row.querySelector('a.togg')?.getAttribute('n')) || 1,
      status,
      text: body.text,
      links: body.links,
      has_code: body.hasCode,
    });
  }
  return { story, comments };
}

// The "More" link at the bottom of a long thread, if any.
export function nextPageHref(doc) {
  return doc.querySelector('a.morelink')?.getAttribute('href') || null;
}
