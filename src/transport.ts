import type { SavedState } from './runtime.js';

const REQUEST_LIMIT = 64, RESPONSE_LIMIT = 1024;

export const TELEGRAM_PROFILE = {
  profile: 1, documentationChecked: '2026-11-11', openui: '1.1.0', language: '1.0 (inherits 0.5)',
  html: 32768, compressedHtml: 4096, request: REQUEST_LIMIT, response: RESPONSE_LIMIT, state: RESPONSE_LIMIT,
} as const;

// QuickJS does not need TextEncoder for byte accounting.
export function utf8Bytes(value: string): number {
  let bytes = 0;
  for (const c of value) {
    const cp = c.codePointAt(0)!;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}
export class TransportSizeError extends RangeError {
  constructor(readonly field: string, readonly bytes: number, readonly limit: number) {
    super(`${field} is ${bytes} UTF-8 bytes; Telegram allows ${limit}`);
  }
}
export function encodeTransport(value: unknown, field: 'request' | 'response' | 'state'): string {
  const result = JSON.stringify(value);
  if (result === undefined) throw new TypeError('Transport value must be JSON serializable');
  const size = utf8Bytes(result), limit = field === 'request' ? REQUEST_LIMIT : RESPONSE_LIMIT;
  if (size > limit) throw new TransportSizeError(field, size, limit);
  return result;
}
export interface StateUpdate {
  instanceId: string; version: number; revision: number; state: SavedState;
}
export interface TelegramEnvironment {
  request(data: string): Promise<{ result: string | null }>;
  chatData: string | null;
  onEvent(event: string, handler: () => void): void;
  offEvent(event: string, handler: () => void): void;
  openLink(url: string): void;
  openTelegramLink(url: string): void;
  ready?(): void;
}
