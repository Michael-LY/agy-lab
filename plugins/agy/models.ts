// Model discovery and cache for the `agy` plugin.
//
// `agy models` prints one `id<TAB>display name` line per model, preceded by an
// ANSI-coloured "Fetching available models..." banner. A cache lets startup
// work offline; when both the cache and the refresh fail the tool falls back to
// a free-form string for `model`.

import { execFile } from "node:child_process"
import { resolveAgyPath } from "./runner.ts"

export const MODELS_CACHE_KEY = "models/cache"
export const MODELS_TIMEOUT_MS = 5000

export type ModelsCache = {
  ids: string[]
  fetchedAt: number
}

export type ModelsResult = {
  ids: string[]
  fetchedAt: number | null
  source: "cache" | "fresh" | "none"
  stale: boolean
  error?: string
}

export type StorageLike = {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

export function parseModelsOutput(raw: string): string[] {
  const ids: string[] = []
  for (const line of raw.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "").split(/\r?\n/)) {
    const cleaned = line.trim()
    if (!cleaned) continue
    const tab = cleaned.indexOf("\t")
    if (tab < 0) continue
    const id = cleaned.slice(0, tab).trim()
    if (!id || /\s/.test(id)) continue
    if (!ids.includes(id)) ids.push(id)
  }
  return ids
}

export async function readModelsCache(storage: StorageLike): Promise<ModelsCache | null> {
  let value: unknown
  try {
    value = await storage.get(MODELS_CACHE_KEY)
  } catch {
    return null
  }
  if (!value || typeof value !== "object") return null
  const cache = value as Record<string, unknown>
  if (!Array.isArray(cache.ids) || typeof cache.fetchedAt !== "number") return null
  const ids = cache.ids.filter((id): id is string => typeof id === "string" && id.length > 0)
  if (!ids.length) return null
  return { ids, fetchedAt: cache.fetchedAt }
}

export function isModelsCacheStale(cache: ModelsCache | null, ttlHours: number, now = Date.now()): boolean {
  if (!cache) return true
  if (!Number.isFinite(ttlHours) || ttlHours <= 0) return true
  return now - cache.fetchedAt >= ttlHours * 60 * 60 * 1000
}

export function fetchModels(options: {
  agyBin?: string
  env?: Record<string, string | undefined>
  timeoutMs?: number
} = {}): Promise<string[]> {
  const agyBin = options.agyBin ?? resolveAgyPath(options.env ?? process.env)
  if (!agyBin) return Promise.reject(new Error("agy was not found on PATH"))

  return new Promise((resolve, reject) => {
    execFile(
      agyBin,
      ["models"],
      {
        encoding: "utf8",
        timeout: options.timeoutMs ?? MODELS_TIMEOUT_MS,
        windowsHide: true,
        env: { ...(options.env ?? process.env), NO_COLOR: "1" },
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr ?? "").trim()
          const shortDetail = detail.length > 400 ? detail.slice(detail.length - 400) : detail
          reject(new Error(`agy models failed${shortDetail ? `: ${shortDetail}` : `: ${error.message}`}`))
          return
        }
        const ids = parseModelsOutput(String(stdout ?? ""))
        if (!ids.length) {
          reject(new Error("agy models returned an empty list"))
          return
        }
        resolve(ids)
      }
    )
  })
}

/**
 * Reads the cache and refreshes it when missing or stale. Never throws: a
 * failed refresh keeps the old cache, and no cache at all becomes `source:
 * "none"` with an empty id list (the tool then accepts a free-form model).
 */
export async function loadModels(
  storage: StorageLike,
  options: {
    ttlHours?: number
    agyBin?: string
    env?: Record<string, string | undefined>
    now?: number
    /** A cache the caller already read; avoids a second storage round trip. */
    cache?: ModelsCache | null
    /** Skip the fresh-cache shortcut and always ask agy. */
    force?: boolean
  } = {}
): Promise<ModelsResult> {
  const now = options.now ?? Date.now()
  const ttlHours = options.ttlHours ?? 24
  const cache = options.cache !== undefined ? options.cache : await readModelsCache(storage)

  if (!options.force && cache && !isModelsCacheStale(cache, ttlHours, now)) {
    return { ids: cache.ids, fetchedAt: cache.fetchedAt, source: "cache", stale: false }
  }

  try {
    const ids = await fetchModels({ agyBin: options.agyBin, env: options.env })
    const fetchedAt = Date.now()
    const next = { ids, fetchedAt }
    try {
      await storage.set(MODELS_CACHE_KEY, next)
    } catch {
      // A broken storage write must not break the tool.
    }
    return { ids, fetchedAt, source: "fresh", stale: false }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (cache) {
      return { ids: cache.ids, fetchedAt: cache.fetchedAt, source: "cache", stale: true, error: message }
    }
    return { ids: [], fetchedAt: null, source: "none", stale: true, error: message }
  }
}
