import {
  getIntegrationRegistry,
  runChain,
  type CapabilityChannelDefinition,
  type ChainStepOutcome,
  type ChannelBinding,
  type ChannelCollection,
  type CredentialRecord,
  type HostModels,
  type HostServices,
} from "../../framework/integrations";
import type { LanguageId } from "../../framework/languages";
import {
  DictionaryChannelError,
  type DictionaryChannelFailure,
  type DictionaryLookupInput,
  type DictionaryLookupResult,
} from "../../integrations/dictionary";
import type { TextGenerationRequest } from "../../modules/ai/contracts/protocol";
import type { AiClientCallOptions, AiClientInput } from "../../modules/ai/runtime/client";
import type { FetchLike } from "../../services/http";
import { createLogger } from "../../services/log";
import { createTextHostModels } from "../models/host-models";
import type { SavedModelRequestResolution } from "../models/store";
import { normalizeLookupTerm } from "./lexical-query";
import { dictionaryChannels } from "./store";

const log = createLogger("dictionary/lookup");

const DEFAULT_DICTIONARY_TIMEOUT_MS = 12_000;
const MAX_CACHE_ENTRIES = 50;

export interface LookupWordRequest {
  term: string;
  contextSentence?: string;
  sourceLanguage?: LanguageId | "auto";
  explanationLanguage: string;
}

export interface LookupWordOptions {
  channels?: ChannelCollection;
  signal?: AbortSignal;
  timeoutMs?: number;
  resolveSavedModelRequest?: (modelId: string) => Promise<SavedModelRequestResolution>;
  generateText?: (
    connection: AiClientInput,
    request: TextGenerationRequest,
    options?: AiClientCallOptions,
  ) => Promise<string>;
  fetchImpl?: FetchLike;
  readCredential?: (credentialRef: string) => Promise<CredentialRecord | null>;
}

export type LookupWordOutcome =
  | { ok: true; result: DictionaryLookupResult; channelId: string }
  | { ok: false; failure: DictionaryChannelFailure };

type DictionaryChannelDefinition = CapabilityChannelDefinition<
  unknown,
  DictionaryLookupInput,
  DictionaryLookupResult
>;

interface DictionaryAttempt {
  id: string;
  binding: ChannelBinding;
  definition: DictionaryChannelDefinition;
}

interface CacheEntry {
  result: DictionaryLookupResult;
  channelId: string;
}

interface InFlightEntry {
  waiters: number;
  controller: AbortController;
  promise: Promise<LookupWordOutcome>;
}

const CACHE = new Map<string, CacheEntry>();
const IN_FLIGHT = new Map<string, InFlightEntry>();
const COLLECTION_TAGS = new WeakMap<ChannelCollection, number>();
let nextCollectionTag = 1;

function collectionTag(channels: ChannelCollection): number {
  let tag = COLLECTION_TAGS.get(channels);
  if (tag === undefined) {
    tag = nextCollectionTag++;
    COLLECTION_TAGS.set(channels, tag);
  }
  return tag;
}

function definitionFor(
  channels: ChannelCollection,
  id: string,
): DictionaryChannelDefinition | null {
  const fromCollection = channels.definition(id) as DictionaryChannelDefinition | null;
  if (fromCollection !== null) return fromCollection;
  return (
    (getIntegrationRegistry()
      .capabilities("dictionary")
      .find((item) => item.id === id) as DictionaryChannelDefinition | undefined) ?? null
  );
}

function enabledAttempts(channels: ChannelCollection): DictionaryAttempt[] {
  const attempts: DictionaryAttempt[] = [];
  for (const id of channels.order()) {
    const binding = channels.binding(id);
    if (!binding || !binding.enabled || !binding.configured) continue;
    const definition = definitionFor(channels, id);
    if (!definition) continue;
    attempts.push({ id, binding, definition });
  }
  return attempts;
}

/** Returns true when at least one dictionary channel is enabled and configured. */
export function isDictionaryConfigured(channels: ChannelCollection = dictionaryChannels): boolean {
  return enabledAttempts(channels).length > 0;
}

/** Clears cached dictionary entries. Intended for tests and manual channel resets. */
export function clearDictionaryCache(): void {
  CACHE.clear();
}

function readCached(key: string): CacheEntry | undefined {
  const cached = CACHE.get(key);
  if (!cached) return undefined;
  CACHE.delete(key);
  CACHE.set(key, cached);
  return cached;
}

function writeCached(key: string, entry: CacheEntry): void {
  if (CACHE.has(key)) CACHE.delete(key);
  while (CACHE.size >= MAX_CACHE_ENTRIES) {
    const oldest = CACHE.keys().next().value;
    if (oldest === undefined) break;
    CACHE.delete(oldest);
  }
  CACHE.set(key, entry);
}

async function readAttemptCredential(
  attempt: DictionaryAttempt,
  channels: ChannelCollection,
  options: LookupWordOptions,
): Promise<CredentialRecord | null> {
  if (attempt.definition.credential === null) return null;
  const ref = attempt.binding.credentialRef;
  if (ref === null) return null;
  return options.readCredential ? options.readCredential(ref) : channels.readCredential(ref);
}

async function runDictionaryAttempt(
  attempt: DictionaryAttempt,
  input: DictionaryLookupInput,
  channels: ChannelCollection,
  options: LookupWordOptions,
  models: HostModels,
): Promise<
  ChainStepOutcome<{ result: DictionaryLookupResult; channelId: string }, DictionaryChannelFailure>
> {
  const credential = await readAttemptCredential(attempt, channels, options);
  const host: HostServices = {
    credential,
    models,
    fetchImpl: options.fetchImpl,
    log,
  };

  let readiness: Awaited<ReturnType<DictionaryChannelDefinition["readiness"]>>;
  try {
    readiness = await attempt.definition.readiness(attempt.binding, host);
  } catch (error) {
    log.warn(`Dictionary channel ${attempt.id} readiness check failed`, error);
    return { kind: "unavailable", reason: "unconfigured" };
  }

  if (input.signal?.aborted) return { kind: "cancelled" };
  if (!readiness.ready) {
    return {
      kind: "unavailable",
      reason: readiness.reason === "no_eligible_model" ? "unconfigured" : "unknown",
    };
  }

  try {
    const result = await attempt.definition.execute(attempt.binding, input, host);
    return { kind: "done", value: { result, channelId: attempt.id } };
  } catch (error) {
    if (input.signal?.aborted) return { kind: "cancelled" };
    if (error instanceof DictionaryChannelError) {
      return error.failure === "cancelled"
        ? { kind: "cancelled" }
        : { kind: "failed", failure: error.failure };
    }
    log.warn(`Dictionary channel ${attempt.id} execution failed`, error);
    return { kind: "failed", failure: "unknown" };
  }
}

async function executeLookupChain(
  cacheKey: string,
  channels: ChannelCollection,
  attempts: readonly DictionaryAttempt[],
  input: DictionaryLookupInput,
  options: LookupWordOptions,
): Promise<LookupWordOutcome> {
  const models = createTextHostModels({
    purpose: "text",
    resolveSavedModelRequest: options.resolveSavedModelRequest,
    generateText: options.generateText,
  });

  log.debug("Running dictionary lookup", {
    term: input.term,
    hasContext: Boolean(input.contextSentence),
    channels: attempts.map((item) => item.id),
  });

  const outcome = await runChain(
    attempts,
    (attempt) => runDictionaryAttempt(attempt, input, channels, options, models),
    { continueOn: (failure) => failure !== "cancelled" },
    input.signal,
  );

  if (outcome.kind === "done") {
    writeCached(cacheKey, outcome.value);
    return { ok: true, ...outcome.value };
  }
  if (outcome.kind === "cancelled") {
    return { ok: false, failure: "cancelled" };
  }
  if (outcome.kind === "unavailable") {
    return { ok: false, failure: outcome.reason ?? "unconfigured" };
  }
  return { ok: false, failure: outcome.failure };
}

function awaitWithCallerSignal(
  key: string,
  entry: InFlightEntry,
  signal?: AbortSignal,
): Promise<LookupWordOutcome> {
  if (!signal) {
    return entry.promise.finally(() => {
      entry.waiters = Math.max(0, entry.waiters - 1);
    });
  }
  if (signal.aborted) {
    entry.waiters = Math.max(0, entry.waiters - 1);
    if (entry.waiters === 0) entry.controller.abort();
    return Promise.resolve({ ok: false, failure: "cancelled" });
  }

  return new Promise<LookupWordOutcome>((resolve) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      entry.waiters = Math.max(0, entry.waiters - 1);
      if (entry.waiters === 0) {
        entry.controller.abort();
        if (IN_FLIGHT.get(key) === entry) IN_FLIGHT.delete(key);
      }
      resolve({ ok: false, failure: "cancelled" });
    };
    signal.addEventListener("abort", onAbort, { once: true });

    void entry.promise.then((result) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      entry.waiters = Math.max(0, entry.waiters - 1);
      resolve(result);
    });
  });
}

/**
 * Looks up a lexical term using enabled dictionary channels in priority order,
 * sharing in-flight requests and caching successful lookups per normalized query and channel config.
 */
export async function lookupWord(
  request: LookupWordRequest,
  options: LookupWordOptions = {},
): Promise<LookupWordOutcome> {
  if (options.signal?.aborted) {
    return { ok: false, failure: "cancelled" };
  }

  const normalizedTerm = normalizeLookupTerm(request.term);
  if (!normalizedTerm) {
    return { ok: false, failure: "invalid_response" };
  }

  const channels = options.channels ?? dictionaryChannels;
  const attempts = enabledAttempts(channels);
  if (attempts.length === 0) {
    return { ok: false, failure: "unconfigured" };
  }

  const trimmedContext = request.contextSentence?.trim() || undefined;
  const fingerprint = attempts
    .map((attempt) => `${attempt.id}:${JSON.stringify(attempt.binding.config)}`)
    .join("|");
  const cacheKey = [
    collectionTag(channels),
    request.explanationLanguage,
    request.sourceLanguage ?? "auto",
    normalizedTerm.toLowerCase(),
    trimmedContext ?? "",
    fingerprint,
  ].join("\u0000");

  const cached = readCached(cacheKey);
  if (cached) {
    log.debug("Dictionary cache hit", { term: normalizedTerm, channelId: cached.channelId });
    return { ok: true, ...cached };
  }

  let pending = IN_FLIGHT.get(cacheKey);
  if (!pending) {
    const controller = new AbortController();
    const input: DictionaryLookupInput = {
      term: normalizedTerm,
      contextSentence: trimmedContext,
      sourceLanguage: request.sourceLanguage,
      explanationLanguage: request.explanationLanguage,
      signal: controller.signal,
      timeoutMs: options.timeoutMs ?? DEFAULT_DICTIONARY_TIMEOUT_MS,
    };
    pending = {
      waiters: 0,
      controller,
      promise: executeLookupChain(cacheKey, channels, attempts, input, options).finally(() => {
        if (IN_FLIGHT.get(cacheKey) === pending) {
          IN_FLIGHT.delete(cacheKey);
        }
      }),
    };
    IN_FLIGHT.set(cacheKey, pending);
  }

  pending.waiters += 1;
  return awaitWithCallerSignal(cacheKey, pending, options.signal);
}
