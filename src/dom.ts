/** Reconcile using native nodes. Unchanged nodes keep listeners, canvas contexts and local state. */
const rendered = new WeakMap<Node, Node>();
const remember = (node: Node, source: Node) => {
  rendered.set(node, source.cloneNode(true));
  for (const [index, child] of Array.from(node.childNodes).entries()) remember(child, source.childNodes[index]);
};
/** Discard lifecycle-owned DOM before this boundary is reused by another instance. */
export function restoreDOM(element: Element) {
  const source = rendered.get(element)!;
  const replacement = source.cloneNode(true);
  remember(replacement, source);
  element.replaceWith(replacement);
}
export function reconcileDOM(root: Element, html: string) {
  const desired = root.ownerDocument.createElement('div');
  desired.innerHTML = html;
  const key = (node: Node) => node.nodeType === 1 ?
    (node as Element).getAttribute('data-oui-key') ?? (node as Element).getAttribute('data-oui-component') ??
      (node as Element).getAttribute('data-oui-node') ?? (node as Element).getAttribute('id') : null;
  const compatible = (a: Node, b: Node) => a.nodeType === b.nodeType &&
    (a.nodeType !== 1 || (a as Element).tagName === (b as Element).tagName && (a as Element).namespaceURI === (b as Element).namespaceURI);
  const morph = (a: Node, b: Node) => {
    const previous = rendered.get(a);
    if (previous?.isEqualNode(b)) return;
    if (a.nodeType !== 1) { if (a.nodeValue !== b.nodeValue) a.nodeValue = b.nodeValue; return; }
    const target = a as Element, source = b as Element;
    const before = previous as Element | undefined;
    for (const attr of Array.from(before?.attributes ?? target.attributes)) if (!source.hasAttribute(attr.name)) target.removeAttribute(attr.name);
    for (const attr of Array.from(source.attributes)) if (!before || before.getAttribute(attr.name) !== attr.value) {
      if (attr.namespaceURI) target.setAttributeNS(attr.namespaceURI, attr.name, attr.value);
      else target.setAttribute(attr.name, attr.value);
    }
    children(target, source);
  };
  const children = (target: Element, source: Element) => {
    const old = Array.from(target.childNodes).filter(node => !rendered.has(target) || rendered.has(node)), used = new Set<Node>();
    const keyed = new Map(old.filter(n => key(n) !== null).map(n => [key(n), n]));
    for (const [index, desiredNode] of Array.from(source.childNodes).entries()) {
      const nodeKey = key(desiredNode);
      let node: Node | undefined = nodeKey !== null ? keyed.get(nodeKey) : old.find(n => !used.has(n) && key(n) === null && compatible(n, desiredNode));
      if (node && (used.has(node) || !compatible(node, desiredNode))) node = undefined;
      if (!node) { node = desiredNode.cloneNode(true); remember(node, desiredNode); }
      else morph(node, desiredNode);
      rendered.set(node, desiredNode.cloneNode(true));
      used.add(node);
      const at = target.childNodes[index] ?? null;
      if (at !== node) target.insertBefore(node, at);
    }
    for (const node of old) if (!used.has(node)) target.removeChild(node);
    rendered.set(target, source.cloneNode(true));
  };
  children(root, desired);
}
