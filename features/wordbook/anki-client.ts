import { createHttpFetch, type FetchLike, type HttpResponseLike } from "../../services/http";

const ANKI_ENDPOINT = "http://127.0.0.1:8765/api/v1";
const REQUEST_DEADLINE_MS = 5_000;
const ENTITY_ID = /^[1-9][0-9]{0,18}$/;
const MAX_ENTITY_ID = 9223372036854775807n;

export interface AnkiClientOptions {
  fetchImpl?: FetchLike;
  /** Sent as `Authorization: Bearer` when non-empty. */
  apiKey?: string;
}

export interface AnkiNamedId {
  id: string;
  name: string;
}

export type AnkiReadFailure =
  | "unreachable"
  | "unauthorized"
  | "forbidden"
  | "unavailable"
  | "noCollection"
  | "staleSession"
  | "malformed"
  | "timeout";

export type AnkiDiscoverResult =
  | {
      ok: true;
      profile: string;
      session: string;
      decks: AnkiNamedId[];
      noteTypes: AnkiNamedId[];
    }
  | { ok: false; failure: AnkiReadFailure };

export type AnkiNoteTypeResult =
  | {
      ok: true;
      id: string;
      name: string;
      kind: "normal" | "cloze";
      fields: string[];
      templateCount: number;
      hasDeckOverride: boolean;
    }
  | { ok: false; failure: AnkiReadFailure };

interface RpcSuccess {
  ok: true;
  result: unknown;
}

interface RpcFailure {
  ok: false;
  failure: AnkiReadFailure;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEntityId(value: unknown): value is string {
  return typeof value === "string" && ENTITY_ID.test(value) && BigInt(value) <= MAX_ENTITY_ID;
}

function isName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function timeoutError(): Error {
  const error = new Error("The operation timed out.");
  error.name = "TimeoutError";
  return error;
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/** Rejects when the request or its body read exceeds the Anki deadline. */
function withDeadline<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(timeoutError());
    }, REQUEST_DEADLINE_MS);
  });
  const attempt = work(controller.signal);
  return Promise.race([attempt, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    void attempt.catch(() => {});
  });
}

/** Legacy AnkiConnect replies put a null or string error beside result and omit JSON-RPC 2.0. */
function isLegacyEnvelope(payload: unknown): boolean {
  if (!isRecord(payload) || payload.jsonrpc === "2.0") return false;
  const hasResult = Object.prototype.hasOwnProperty.call(payload, "result");
  const hasError = Object.prototype.hasOwnProperty.call(payload, "error");
  if (!hasResult && !hasError) return false;
  const error = payload.error;
  return error === null || error === undefined || typeof error === "string";
}

function failureFromRpc(error: unknown): AnkiReadFailure {
  if (!isRecord(error) || !isRecord(error.data) || typeof error.data.type !== "string") {
    return "malformed";
  }
  if (error.data.type === "collectionUnavailable") return "noCollection";
  if (error.data.type === "staleSession") return "staleSession";
  return "malformed";
}

function normalDecks(result: unknown): AnkiNamedId[] | null {
  if (!Array.isArray(result)) return null;
  const decks: AnkiNamedId[] = [];
  for (const item of result) {
    if (!isRecord(item) || !isEntityId(item.id) || !isName(item.name)) return null;
    if (item.kind === "filtered") continue;
    if (item.kind !== "normal") return null;
    decks.push({ id: item.id, name: item.name });
  }
  return decks;
}

function readNoteType(
  result: unknown,
  requestedId: string,
): Extract<AnkiNoteTypeResult, { ok: true }> | null {
  if (
    !isRecord(result) ||
    result.id !== requestedId ||
    !isEntityId(result.id) ||
    !isName(result.name)
  ) {
    return null;
  }
  if (result.kind !== "normal" && result.kind !== "cloze") return null;
  if (!Array.isArray(result.fields) || result.fields.length === 0) return null;
  const fields: string[] = [];
  for (const field of result.fields) {
    if (!isRecord(field) || !isName(field.name)) return null;
    fields.push(field.name);
  }
  if (!Array.isArray(result.templates) || result.templates.length === 0) return null;
  let hasDeckOverride = false;
  for (const template of result.templates) {
    if (!isRecord(template) || !isName(template.name)) return null;
    if (template.deck !== undefined && template.deck !== null) hasDeckOverride = true;
  }
  return {
    ok: true,
    id: result.id,
    name: result.name,
    kind: result.kind,
    fields,
    templateCount: result.templates.length,
    hasDeckOverride,
  };
}

function noteTypeSummaries(result: unknown): AnkiNamedId[] | null {
  if (!Array.isArray(result)) return null;
  const noteTypes: AnkiNamedId[] = [];
  for (const item of result) {
    if (!isRecord(item) || !isEntityId(item.id) || !isName(item.name)) return null;
    noteTypes.push({ id: item.id, name: item.name });
  }
  return noteTypes;
}

/** Discovers the open Anki profile, its normal decks, and its note type summaries. */
export function createAnkiClient(options: AnkiClientOptions) {
  const send = createHttpFetch({
    scope: "wordbook/anki",
    logBodies: false,
    logFailures: false,
    fetchImpl: options.fetchImpl,
  });
  let requestId = 0;

  async function rpc(
    method: string,
    params: Record<string, unknown>,
  ): Promise<RpcSuccess | RpcFailure> {
    const id = ++requestId;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.apiKey) headers.Authorization = "Bearer " + options.apiKey;
    let received: { status: number; payload?: unknown };
    try {
      received = await withDeadline(async (signal) => {
        const response: HttpResponseLike = await send(ANKI_ENDPOINT, {
          method: "POST",
          headers,
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          redirect: "error",
          signal,
        });
        if (response.status !== 200) return { status: response.status };
        return { status: 200, payload: await response.json() };
      });
    } catch (error) {
      if (isTimeout(error)) return { ok: false, failure: "timeout" };
      if (error instanceof SyntaxError) return { ok: false, failure: "malformed" };
      return { ok: false, failure: "unreachable" };
    }
    if (received.status === 401) return { ok: false, failure: "unauthorized" };
    if (received.status === 403) return { ok: false, failure: "forbidden" };
    if (received.status !== 200) return { ok: false, failure: "unavailable" };
    const payload = received.payload;
    if (isLegacyEnvelope(payload)) return { ok: false, failure: "unavailable" };
    if (!isRecord(payload) || payload.id !== id) return { ok: false, failure: "malformed" };
    const hasResult = Object.prototype.hasOwnProperty.call(payload, "result");
    const hasError = Object.prototype.hasOwnProperty.call(payload, "error");
    if (hasResult === hasError) return { ok: false, failure: "malformed" };
    if (hasError) return { ok: false, failure: failureFromRpc(payload.error) };
    return { ok: true, result: payload.result };
  }

  return {
    async discover(): Promise<AnkiDiscoverResult> {
      const collection = await rpc("collection.get", {});
      if (!collection.ok) return collection;
      if (
        !isRecord(collection.result) ||
        !isName(collection.result.profile) ||
        !isName(collection.result.session)
      ) {
        return { ok: false, failure: "malformed" };
      }
      const profile = collection.result.profile;
      const session = collection.result.session;
      const decksReply = await rpc("decks.list", { session });
      if (!decksReply.ok) return decksReply;
      const typesReply = await rpc("noteTypes.list", { session });
      if (!typesReply.ok) return typesReply;
      const decks = normalDecks(decksReply.result);
      if (!decks) return { ok: false, failure: "malformed" };
      const noteTypes = noteTypeSummaries(typesReply.result);
      if (!noteTypes) return { ok: false, failure: "malformed" };
      return { ok: true, profile, session, decks, noteTypes };
    },
    async getNoteType(session: string, noteTypeId: string): Promise<AnkiNoteTypeResult> {
      if (!isName(session) || !isEntityId(noteTypeId)) return { ok: false, failure: "malformed" };
      const reply = await rpc("noteTypes.get", { noteType: { id: noteTypeId }, session });
      if (!reply.ok) return reply;
      return readNoteType(reply.result, noteTypeId) ?? { ok: false, failure: "malformed" };
    },
  };
}
