import { t } from "nsh/i18n";
import { ProviderProtocolError } from "../contracts/errors";
import type { RemoteModelRecord } from "../contracts/model";
import type {
  ProtocolConnection,
  RequestOperation,
  ResolvedRequestTarget,
} from "../contracts/protocol";
import { normalizeCredential, normalizeRequestRoot } from "./shared";

/** Adds transient Bearer authentication when the connection carries a credential. */
export function withBearer(
  headers: Record<string, string>,
  credential: string | null,
): Record<string, string> {
  const token = normalizeCredential(credential);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

/** Truncates a positive finite number; anything else is unknown. */
export function normalizePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.trunc(value);
  return rounded > 0 ? rounded : null;
}

/** Builds the standard `GET /models` catalog target under the preserved root. */
export function resolveOpenAICatalogTarget(
  connection: ProtocolConnection,
  operation: RequestOperation,
): ResolvedRequestTarget {
  const query = new URLSearchParams(operation.kind === "catalog" ? operation.queryExtras : {});
  const path = `${normalizeRequestRoot(connection.baseUrl)}/models`;
  const qs = query.toString();
  return {
    method: "GET",
    url: qs.length > 0 ? `${path}?${qs}` : path,
    headers: withBearer({ Accept: "application/json" }, connection.credential),
  };
}

/** Decodes one OpenAI-style `{ data: [...] }` catalog page with nullable capabilities. */
export function decodeOpenAICatalogPage(payload: Record<string, unknown>): RemoteModelRecord[] {
  if (!Array.isArray(payload.data)) {
    throw new ProviderProtocolError("invalid_response", t("protocol.error.missingModels"));
  }

  const records: RemoteModelRecord[] = [];
  for (const raw of payload.data) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const modelKey = typeof item.id === "string" ? item.id.trim() : "";
    if (!modelKey) continue;
    const displayName =
      typeof item.display_name === "string" && item.display_name.trim()
        ? item.display_name.trim()
        : null;
    records.push({
      modelKey,
      displayName,
      contextLimit: normalizePositiveInt(item.context_window ?? item.context_length),
      maxTokens: normalizePositiveInt(item.max_tokens ?? item.max_output_tokens),
      capabilities: null,
    });
  }
  return records;
}

/** Deduplicates remote records by model key, keeping the first occurrence. */
export function dedupeRemoteModels(records: readonly RemoteModelRecord[]): RemoteModelRecord[] {
  const unique = new Map<string, RemoteModelRecord>();
  for (const record of records) {
    if (!unique.has(record.modelKey)) {
      unique.set(record.modelKey, record);
    }
  }
  return Array.from(unique.values());
}
