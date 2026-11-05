import DOMPurify from 'dompurify';
import { Fragment } from 'react';

function parts(text: string): { text: string; url?: string }[] {
  const result: { text: string; url?: string }[] = [];
  const pattern = /https?:\/\/[^\s<>"']+/gi;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index!;
    let url = match[0].replace(/[.,;!]+$/, '');
    while (url.endsWith(')') && (url.match(/\)/g)?.length || 0) > (url.match(/\(/g)?.length || 0)) url = url.slice(0,-1);
    try { if (!['http:', 'https:'].includes(new URL(url).protocol)) continue; } catch { continue; }
    result.push({ text: text.slice(last,start) }, { text: url, url });
    last = start + url.length;
  }
  result.push({ text: text.slice(last) });
  return result;
}
export function LinkedText({ text, onError }: { text: string; onError: (error: unknown) => void }) {
  return <pre>{parts(text).map((part, index) => part.url
    ? <a key={index} href={part.url} onClick={(event) => { event.preventDefault(); void window.mailgrid.openExternal(part.url!).catch(onError); }}>{part.text}</a>
    : <Fragment key={index}>{part.text}</Fragment>)}</pre>;
}
export function messagePreviewHTML(html: string, text: string, dark = false) {
  if (html?.trim()) return safeHTML(html, dark);
  if (!text?.trim()) return null;
  const content = document.createElement('div');
  content.style.whiteSpace = 'pre-wrap';
  content.textContent = text;
  return safeHTML(content.outerHTML, dark);
}
export function safeHTML(input: string, dark = false) {
  const clean = DOMPurify.sanitize(input, {
    RETURN_DOM: true, WHOLE_DOCUMENT: true, USE_PROFILES: { html: true },
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'meta', 'base', 'link'],
    FORBID_ATTR: ['srcset', 'action', 'formaction', 'target', 'download', 'ping'],
  }) as HTMLElement;
  // Keep email-local CSS, including <head><style>, inside the isolated frame.
  // External images, scripts, forms and stylesheets remain blocked.
  for(const element of clean.querySelectorAll('[src]')){
    const source=element.getAttribute('src')||'';
    if(element.tagName!=='IMG'||!/^data:image\/(?:png|jpeg|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i.test(source))element.removeAttribute('src');
  }
  const body=clean.querySelector('body')||clean;
  const doc = clean.ownerDocument!;
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) if (!walker.currentNode.parentElement?.closest('a,style,pre,code')) texts.push(walker.currentNode as Text);
  for (const text of texts) {
    const fragments = parts(text.data);
    if (!fragments.some((part) => part.url)) continue;
    const fragment = doc.createDocumentFragment();
    for (const part of fragments) {
      if (part.url) { const link = doc.createElement('a'); link.href = part.url; link.textContent = part.text; fragment.append(link); }
      else fragment.append(doc.createTextNode(part.text));
    }
    text.replaceWith(fragment);
  }
  for (const link of body.querySelectorAll('a[href],area[href]')) {
    const href = link.getAttribute('href') || '';
    if (href.startsWith('#')) continue;
    try {
      const url = new URL(href.startsWith('//') ? 'https:' + href : href);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      link.setAttribute('href', url.href); link.setAttribute('target', '_blank'); link.setAttribute('rel', 'noreferrer noopener'); link.setAttribute('title', url.href);
    } catch { link.removeAttribute('href'); }
  }
  // Preserve the sanitized <html>/<body> attributes too: email templates often
  // put their colors, typography or text direction directly on <body>.
  const head=clean.querySelector('head')||doc.createElement('head');
  if(!head.parentNode)clean.prepend(head);
  const policy=doc.createElement('meta');policy.httpEquiv='Content-Security-Policy';
  policy.content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none';";
  const base=doc.createElement('style');base.textContent=`html{color:${dark ? '#dbe4f2' : '#273448'};background:${dark ? '#192334' : '#fff'};color-scheme:${dark ? 'dark' : 'light'};font:14px system-ui,sans-serif}body{padding:24px;margin:0;overflow-wrap:anywhere}img{max-width:100%;height:auto}a{color:${dark ? '#99b8ff' : '#3150c9'};text-decoration:underline}`;
  head.prepend(base);head.prepend(policy);
  return '<!doctype html>'+clean.outerHTML;
}
