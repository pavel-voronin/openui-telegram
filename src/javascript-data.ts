/** Emit data literals, never executable input strings. Unlike JSON syntax used as
 * JavaScript, computed __proto__ keys preserve own properties without changing prototypes. */
export function javascriptData(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (value === undefined) return 'void 0';
  if (typeof value === 'string') return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : String(value);
  if (typeof value !== 'object' || ancestors.has(value)) throw new TypeError('Bootstrap data must be acyclic data values');
  if (Object.getOwnPropertySymbols(value).length) throw new TypeError('Symbol properties cannot be embedded');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const elements = Array.from({ length: value.length }, (_, i) => Object.hasOwn(value, i) ? javascriptData(value[i], ancestors) : '');
      return '[' + elements.join(',') + (value.length && !Object.hasOwn(value, value.length - 1) ? ',' : '') + ']';
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) throw new TypeError('Bootstrap objects must be plain data');
    const properties = Object.entries(Object.getOwnPropertyDescriptors(value)).map(([key, descriptor]) => {
      if (!('value' in descriptor)) throw new TypeError('Accessor properties cannot be embedded');
      const name = key === '__proto__' ? `[${javascriptData(key)}]` : javascriptData(key);
      return `${name}:${javascriptData(descriptor.value, ancestors)}`;
    });
    const object = '{' + properties.join(',') + '}';
    return prototype === null ? `Object.assign(Object.create(null),${object})` : object;
  } finally { ancestors.delete(value); }
}
