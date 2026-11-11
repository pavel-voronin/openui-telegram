import type { WidgetFrame } from './controller.js';

export type FrameChange = [0, string[], unknown] | [1, string[]] | [2, string[], [number, number, string][]] |
  [3, string[], number, number, unknown[]];
export interface WidgetUpdate {
  i: string; v: number; r: number; b: [version: number, revision: number]; d: FrameChange[];
}

/** Apply atomically against the exact base, including when a patch changes the program version. */
export function applyWidgetUpdate(base: WidgetFrame, update: WidgetUpdate): WidgetFrame {
  if (update.i !== base.i || update.b[0] !== base.v || update.b[1] !== base.r)
    throw new Error('Update requires a different base frame');
  if (update.v < base.v || update.v === base.v && update.r <= base.r) throw new Error('Obsolete frame update');
  const result = JSON.parse(JSON.stringify(base));
  for (const change of update.d) {
    const [kind, path] = change;
    if (!path.length || !['h', 'c', 'f', 'e', 'l', 's'].includes(path[0])) throw new Error('Invalid update path');
    let parent = result;
    for (const key of path.slice(0, -1)) {
      if (!parent || typeof parent !== 'object' || !Object.prototype.hasOwnProperty.call(parent, key)) throw new Error('Missing update parent');
      parent = parent[key];
    }
    const key = path[path.length - 1];
    if (kind === 3) {
      if (!Array.isArray(parent[key])) throw new Error('Array update requires an array');
      const [, , start, remove, items] = change;
      if (!Number.isInteger(start) || !Number.isInteger(remove) || start < 0 || remove < 0 || start + remove > parent[key].length)
        throw new Error('Invalid array update range');
      parent[key].splice(start, remove, ...items);
    } else if (kind === 1) delete parent[key];
    else {
      let value = change[2];
      if (kind === 2) {
        if (typeof parent[key] !== 'string') throw new Error('Text update requires a string');
        let text = parent[key];
        for (const [offset, remove, insert] of [...change[2]].reverse()) {
          if (!Number.isInteger(offset) || !Number.isInteger(remove) || offset < 0 || remove < 0 || offset + remove > text.length)
            throw new Error('Invalid text update range');
          text = text.slice(0, offset) + insert + text.slice(offset + remove);
        }
        value = text;
      }
      Object.defineProperty(parent, key, { value, enumerable: true, configurable: true, writable: true });
    }
  }
  result.v = update.v; result.r = update.r;
  return result;
}
