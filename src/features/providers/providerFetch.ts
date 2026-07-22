// ABOUTME: Fetch-like facade over provider_http_request / provider_http_stream IPC.
// ABOUTME: Wires AbortSignal to cancel_provider_http; never accepts secret fields.
import { Channel } from "@tauri-apps/api/core";
import { invokeEffect } from "../../storage/invokeEffect";
import { runStorage } from "../../storage/runStorage";
import type { ProviderHttpRequest, ProviderHttpResponse, ProviderHttpStreamEvent, ProviderWireRequest } from "./types";

export type ProviderFetchInput = {
  requestId: string;
  providerInstanceId: string;
  wire: ProviderWireRequest;
  signal?: AbortSignal;
};

function assertNoSecretFields(wire: ProviderWireRequest): void {
  const banned = ["secret", "apiKey", "api_key", "credentialRef", "authorization", "Authorization"];
  for (const key of Object.keys(wire.headers)) {
    if (banned.some((b) => b.toLowerCase() === key.toLowerCase())) {
      throw new Error(`wire headers must not include '${key}'`);
    }
  }
  for (const [name] of wire.query) {
    if (banned.some((b) => b.toLowerCase() === name.toLowerCase())) {
      throw new Error(`wire query must not include '${name}'`);
    }
  }
}

async function cancelProviderHttp(requestId: string): Promise<void> {
  try {
    await runStorage(invokeEffect<boolean>("cancel_provider_http", { requestId }));
  } catch {
    // Cancellation is best-effort and idempotent.
  }
}

function attachAbort(requestId: string, signal: AbortSignal | undefined): () => void {
  if (!signal) {
    return () => {};
  }
  if (signal.aborted) {
    void cancelProviderHttp(requestId);
    return () => {};
  }
  let cancelled = false;
  const onAbort = () => {
    if (cancelled) {
      return;
    }
    cancelled = true;
    void cancelProviderHttp(requestId);
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return () => {
    signal.removeEventListener("abort", onAbort);
  };
}

/** Non-stream provider HTTP request. */
export async function providerFetch(input: ProviderFetchInput): Promise<ProviderHttpResponse> {
  assertNoSecretFields(input.wire);
  const payload: ProviderHttpRequest = {
    requestId: input.requestId,
    providerInstanceId: input.providerInstanceId,
    wire: input.wire,
  };
  const detach = attachAbort(input.requestId, input.signal);
  try {
    if (input.signal?.aborted) {
      throw new Error("request cancelled");
    }
    return await runStorage(invokeEffect<ProviderHttpResponse>("provider_http_request", { input: payload }));
  } finally {
    detach();
  }
}

export type ProviderFetchStreamHandlers = {
  onStarted?: (status: number, headers: Record<string, string>) => void;
  onChunk: (bytes: Uint8Array) => void;
  onFinished?: () => void;
};

/** Streaming provider HTTP request via Tauri Channel. */
export async function providerFetchStream(
  input: ProviderFetchInput,
  handlers: ProviderFetchStreamHandlers,
): Promise<void> {
  assertNoSecretFields(input.wire);
  const payload: ProviderHttpRequest = {
    requestId: input.requestId,
    providerInstanceId: input.providerInstanceId,
    wire: input.wire,
  };
  const detach = attachAbort(input.requestId, input.signal);
  const channel = new Channel<ProviderHttpStreamEvent>();
  channel.onmessage = (event) => {
    if (event.event === "started") {
      handlers.onStarted?.(event.data.status, event.data.headers);
      return;
    }
    if (event.event === "chunk") {
      handlers.onChunk(Uint8Array.from(event.data.bytes));
      return;
    }
    if (event.event === "finished") {
      handlers.onFinished?.();
    }
  };
  try {
    if (input.signal?.aborted) {
      throw new Error("request cancelled");
    }
    await runStorage(
      invokeEffect<void>("provider_http_stream", {
        input: payload,
        onEvent: channel,
      }),
    );
  } finally {
    detach();
  }
}
