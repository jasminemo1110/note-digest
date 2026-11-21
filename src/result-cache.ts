import { digestText } from './anchors';

export interface LocalCacheStorage {
  load(key: string): unknown;
  save(key: string, value: unknown): void;
}

const PREFERENCE = 'note-digest-retain-results';
const PREFERENCE_DISABLED = 'disabled';
const RESULTS = 'note-digest-results-v1';
const ACCESS_ORDER = 'note-digest-results-access-order-v1';
const MAX_ENTRIES = 256;
const MAX_SIZE = 1_000_000;

function isCacheKey(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function readEntries(input: unknown): Map<string, unknown> {
  if (!Array.isArray(input)) return new Map();
  return new Map(input.slice(-MAX_ENTRIES).filter((entry): entry is [string, unknown] =>
    Array.isArray(entry) && entry.length === 2 && isCacheKey(entry[0])));
}

function readAccessOrder(input: unknown): string[] | undefined {
  if (Array.isArray(input)) return [...new Set(input.slice(-MAX_ENTRIES).filter(isCacheKey))];
}

function remember(entries: Map<string, unknown>, key: string, value: unknown): void {
  entries.delete(key);
  entries.set(key, value);
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
}

export interface ResultRequest {
  cache?: ResultCache;
  regenerate?: boolean;
  onRequest?: () => void;
}

/** Memory is always available. The optional vault-specific local store survives Obsidian restarts. */
export class ResultCache {
  private readonly memory = new Map<string, unknown>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly storage: LocalCacheStorage) {}

  get persistent(): boolean {
    try {
      const preference = this.storage.load(PREFERENCE);
      return preference === true || preference == null;
    }
    catch { return false; }
  }

  setPersistent(enabled: boolean): void {
    if (!enabled) {
      this.storage.save(RESULTS, null);
      this.storage.save(ACCESS_ORDER, null);
    }
    // Obsidian's local preference reader treats stored false as an absent value.
    this.storage.save(PREFERENCE, enabled ? true : PREFERENCE_DISABLED);
    if (enabled) this.persist(this.memory);
  }

  async run<T>(identity: unknown, validate: (value: unknown) => T, request: () => Promise<unknown>,
    options: ResultRequest): Promise<T> {
    const key = await digestText(JSON.stringify(identity));
    let pending = this.inFlight.get(key);
    if (!pending && !options.regenerate) {
      const persistent = this.persistent;
      let saved = this.memory.get(key);
      let stored: Map<string, unknown> | undefined;
      if (saved === undefined && persistent) {
        try {
          stored = readEntries(this.storage.load(RESULTS));
          saved = stored.get(key);
        }
        catch { /* The memory cache still works when local storage is unavailable. */ }
      }
      if (saved !== undefined) {
        try {
          const result = validate(saved);
          remember(this.memory, key, saved);
          if (persistent) this.recordAccess(key, stored);
          return result;
        } catch { this.memory.delete(key); }
      }
    }
    options.onRequest?.();
    if (!pending) {
      pending = request().then(value => {
        const result = validate(value);
        remember(this.memory, key, result);
        if (this.persistent) this.persist([[key, result]]);
        return result;
      }).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }
    return validate(await pending);
  }

  private recordAccess(key: string, stored?: Map<string, unknown>): void {
    try {
      const savedOrder = readAccessOrder(this.storage.load(ACCESS_ORDER));
      const order = savedOrder ?? [...(stored ?? readEntries(this.storage.load(RESULTS))).keys()];
      const index = order.indexOf(key);
      if (index === -1 || (savedOrder && index === order.length - 1)) return;
      order.splice(index, 1);
      order.push(key);
      this.storage.save(ACCESS_ORDER, order);
    } catch { /* A cache hit remains usable when the access order cannot be saved. */ }
  }

  private persist(updates: Iterable<[string, unknown]>): void {
    try {
      const stored = readEntries(this.storage.load(RESULTS));
      const entries = new Map<string, unknown>();
      for (const key of readAccessOrder(this.storage.load(ACCESS_ORDER)) ?? []) {
        if (stored.has(key)) {
          entries.set(key, stored.get(key));
          stored.delete(key);
        }
      }
      for (const [key, value] of stored) entries.set(key, value);
      for (const [key, value] of updates) remember(entries, key, value);
      const saved: [string, unknown][] = [];
      let size = 2;
      for (const entry of [...entries].reverse()) {
        size += JSON.stringify(entry).length + 1;
        if (size > MAX_SIZE) break;
        saved.push(entry);
      }
      saved.reverse();
      this.storage.save(RESULTS, saved);
      this.storage.save(ACCESS_ORDER, saved.map(([key]) => key));
    } catch { /* A local storage error should never discard the successful reading result. */ }
  }
}
