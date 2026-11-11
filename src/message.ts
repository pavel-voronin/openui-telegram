export interface ResponsePart {
  kind: 'text' | 'code'; language?: string; content: string; raw: string; complete: boolean;
}
/** Preserve prose and code separately. Language parsing still goes through upstream,
 * using the original content, not a reconstruction of these presentation segments. */
export function responseParts(content: string): ResponsePart[] {
  const parts: ResponsePart[] = [];
  let raw = '', body = '', language: string | undefined, fenced = false, quoted = false;
  const flush = (complete: boolean) => {
    if (raw) parts.push({ kind: fenced ? 'code' : 'text', language, content: fenced ? body : raw, raw, complete });
    raw = ''; body = '';
  };
  for (const line of content.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const fence = !quoted && /^[ \t]*```[ \t]*([\w.+-]*)[ \t]*(.*?)[ \t]*\r?\n?$/.exec(line);
    if (fence) {
      if (fenced) { raw += line; flush(true); fenced = false; language = undefined; }
      else { flush(true); fenced = true; language = fence[1]; raw = line; body = fence[2] ? fence[2] + '\n' : ''; }
    } else {
      raw += line; if (fenced) {
        body += line;
        for (let i = 0; i < line.length; i++) {
          if (line[i] === '\\' && quoted) i++;
          else if (line[i] === '"') quoted = !quoted;
        }
      }
    }
  }
  flush(!fenced); return parts;
}
