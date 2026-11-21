import { digestText } from './anchors';

export interface LocalCacheStorage {
  load(key: string): unknown;
  save(key: string, value: unknown): void;
}

const PREFERENCE = 'note-digest-retain-results';
const RESULTS = 'note-digest-results-v1';
const MAX_ENTRIES = 256;
const MAX_SIZE = 1_000_000;

function readEntries(input: unknown): Map<string, unknown> {
  if (!Array.isArray(input)) return new Map();
  return new Map(input.slice(-MAX_ENTRIES).filter((entry): entry is [string, unknown] =>
    Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && /^[0-9a-f]{64}$/.test(entry[0])));
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
    try { return this.storage.load(PREFERENCE) === true; }
    catch { return false; }
  }

  setPersistent(enabled: boolean): void {
    if (!enabled) this.storage.save(RESULTS, null);
    this.storage.save(PREFERENCE, enabled ? true : null);
    if (enabled) this.persist(this.memory);
  }

  async run<T>(identity: unknown, validate: (value: unknown) => T, request: () => Promise<unknown>,
    options: ResultRequest): Promise<T> {
    const key = await digestText(JSON.stringify(identity));
    let pending = this.inFlight.get(key);
    if (!pending && !options.regenerate) {
      let saved = this.memory.get(key);
      if (saved === undefined && this.persistent) {
        try { saved = readEntries(this.storage.load(RESULTS)).get(key); }
        catch { /* The memory cache still works when local storage is unavailable. */ }
      }
      if (saved !== undefined) {
        try {
          const result = validate(saved);
          remember(this.memory, key, saved);
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

  private persist(updates: Iterable<[string, unknown]>): void {
    try {
      const entries = readEntries(this.storage.load(RESULTS));
      for (const [key, value] of updates) remember(entries, key, value);
      const saved: [string, unknown][] = [];
      let size = 2;
      for (const entry of [...entries].reverse()) {
        size += JSON.stringify(entry).length + 1;
        if (size > MAX_SIZE) break;
        saved.push(entry);
      }
      this.storage.save(RESULTS, saved.reverse());
    } catch { /* A local storage error should never discard the successful reading result. */ }
  }
}
