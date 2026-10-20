import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

class TestNode {
  children: TestNode[] = [];
  className = '';
  disabled = false;
  constructor(readonly tag: string, private text = '') {}
  get textContent(): string { return this.text + this.children.map(node => node.textContent).join(''); }
  set textContent(value: string) { this.text = value; this.children = []; }
  set innerHTML(_value: string) { throw new Error('HTML parsing must not be used for status messages'); }
  replaceChildren(...nodes: TestNode[]) { this.text = ''; this.children = nodes; }
}

function loadPage(path: string, location = { hostname: 'example.invalid', port: '', href: 'https://example.invalid/<img src=x onerror=attack()>' }) {
  const nodes = { status: new TestNode('div'), clearBtn: new TestNode('button'), goBtn: new TestNode('button') };
  nodes.goBtn.disabled = true;
  const elements: TestNode[] = [];
  const listeners = new Map<string, () => void>();
  const document = {
    cookie: 'one=1;two=2',
    getElementById: (id: keyof typeof nodes) => nodes[id],
    createTextNode: (text: string) => new TestNode('#text', text),
    createElement: (tag: string) => { const node = new TestNode(tag); elements.push(node); return node; },
  };
  const context = createContext({ document, window: { location, addEventListener: (event: string, callback: () => void) => listeners.set(event, callback) } });
  const html = readFileSync(resolve(process.cwd(), path), 'utf8');
  const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</script>'));
  runInContext(script, context);
  return { nodes, elements, document, location, listeners, clear: () => runInContext('clearCookies()', context), go: () => runInContext('goToDashboard()', context) };
}

describe.each(['clear-cookies.html', 'client/public/clear-cookies.html'])('%s DOM status messages', path => {
  it('shows an untrusted location as text on load and on a wrong-host clear attempt', () => {
    const page = loadPage(path);
    page.listeners.get('load')!();
    expect(page.nodes.status.textContent).toContain(page.location.href);
    expect(page.nodes.status.textContent).toContain('Required location: http://localhost:3001/clear-cookies.html');
    expect(page.nodes.clearBtn.disabled).toBe(true);
    expect(page.elements.map(node => node.tag)).toContain('strong');
    page.clear();
    expect(page.nodes.status.className).toBe('status error');
    expect(page.nodes.status.textContent).toContain('Warning: This page is not opened from localhost:3001.');
    expect(page.nodes.status.textContent).toContain(page.location.href);
    expect(page.elements.every(node => ['br', 'strong', 'code'].includes(node.tag))).toBe(true);
  });

  it('preserves cookie clearing, success text, button states and dashboard navigation', () => {
    const page = loadPage(path, { hostname: 'localhost', port: '3001', href: 'http://localhost:3001/clear-cookies.html' });
    const writes = vi.fn();
    Object.defineProperty(page.document, 'cookie', { get: () => 'one=1;two=2', set: writes });
    page.clear();
    expect(writes).toHaveBeenCalledTimes(6);
    expect(page.nodes.status.className).toBe('status success');
    expect(page.nodes.status.textContent).toContain('Success! Cleared 2 cookie(s).');
    expect(page.nodes.status.textContent).toContain('Click "Go to Dashboard" to test the login form.');
    expect(page.nodes.clearBtn.disabled).toBe(true);
    expect(page.nodes.goBtn.disabled).toBe(false);
    page.go();
    expect(page.location.href).toBe('/');
  });

  it('renders error details as text without creating injected elements', () => {
    const page = loadPage(path);
    const message = '<img src=x onerror=attack()>';
    Object.defineProperty(page.document, 'cookie', { get: () => { throw new Error(message); } });
    page.clear();
    expect(page.nodes.status.textContent).toContain(`Error clearing cookies: ${message}`);
    expect(page.nodes.status.textContent).toContain('Please use the manual method below.');
    expect(page.elements.map(node => node.tag)).toEqual(['br']);
  });
});
