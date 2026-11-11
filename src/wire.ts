import { diffChars } from 'diff';
import type { WidgetFrame } from './controller.js';
import type { FrameChange, WidgetUpdate } from './wire-apply.js';
import { utf8Bytes } from './transport.js';

export function createWidgetUpdate(base: WidgetFrame, next: WidgetFrame): WidgetUpdate {
  if (base.i !== next.i) throw new Error('Cannot diff different interface instances');
  const changes: FrameChange[] = [];
  const diff = (a: any, b: any, path: string[]) => {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (typeof a === 'string' && typeof b === 'string') {
      let offset = 0, edit: [number, number, string] | undefined;
      const edits: [number, number, string][] = [];
      for (const part of diffChars(a, b)) {
        if (!part.added && !part.removed) { offset += part.value.length; edit = undefined; continue; }
        if (!edit) { edit = [offset, 0, '']; edits.push(edit); }
        if (part.removed) { edit[1] += part.value.length; offset += part.value.length; }
        else edit[2] += part.value;
      }
      const delta: FrameChange = [2, path, edits], replacement: FrameChange = [0, path, b];
      changes.push(utf8Bytes(JSON.stringify(delta)) < utf8Bytes(JSON.stringify(replacement)) ? delta : replacement);
    } else if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length === b.length) { for (let i = 0; i < a.length; i++) diff(a[i], b[i], [...path, String(i)]); }
      else {
        let start = 0, end = 0;
        while (start < Math.min(a.length, b.length) && JSON.stringify(a[start]) === JSON.stringify(b[start])) start++;
        while (end < Math.min(a.length, b.length) - start && JSON.stringify(a[a.length - 1 - end]) === JSON.stringify(b[b.length - 1 - end])) end++;
        changes.push([3, path, start, a.length - start - end, b.slice(start, b.length - end)]);
      }
    } else if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
      for (const key of Object.keys(a)) if (!Object.hasOwn(b, key)) changes.push([1, [...path, key]]);
      for (const key of Object.keys(b)) {
        if (!Object.hasOwn(a, key)) changes.push([0, [...path, key], b[key]]);
        else diff(a[key], b[key], [...path, key]);
      }
    } else changes.push([0, path, b]);
  };
  for (const key of ['h', 'c', 'f', 'e', 'l', 's'] as const) {
    if (base[key] !== undefined && next[key] === undefined) changes.push([1, [key]]);
    else diff(base[key], next[key], [key]);
  }
  return { i: next.i, v: next.v, r: next.r, b: [base.v, base.r], d: changes };
}
