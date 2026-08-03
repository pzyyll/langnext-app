// ABOUTME: Frontend non-stream/stream translation orchestration with ordered fallback.
// ABOUTME: Applies stream deltas/errors from plugins; records history once on terminal outcomes.
import { invokeEffect } from "../../storage/invokeEffect";
import { runStorage } from "../../storage/runStorage";
import type { TranslateInput, TranslateResult } from "../../storage/types";
import { normalizeProviderError } from "../providers/errors";
import type { ExecutorChatInput } from "../providers/executor";
import { newClientRequestId } from "./newClientRequestId";
import {
  resolveTranslationContext,
  type LlmTranslationExecutionContext,
  type ServiceTranslationExecutionContext,
  type TranslationContextSnapshots,
} from "./translationContext";

export type TranslationStreamHandlers = {
  onChunk: (delta: string) => void;
  /**
   * Model/service display key for UI reset.
   * LLM: model id (looked up by callers). Service: non-UUID integration/capability label.
   */
  onReset: (modelOrServiceLabel: string) => void;
  onDone: (result: TranslateResult) => void;
  onError: (result: TranslateResult) => void;
};

async function recordHistoryBestEffort(input: {
  completionId: string;
  ok: boolean;
  translatedText: string;
  errorCode: string | null;
  message: string;
  modelId: string | null;
  modelDisplayName: string;
  providerDisplayName: string | null;
  profileId: string | null;
  profileName: string | null;
  latencyMs: number;
  sourceLang: string;
  targetLang: string;
  sourceText: string;
  effectiveSourceLang: string | null;
  effectiveTargetLang: string | null;
}): Promise<void> {
  try {
    await runStorage(
      invokeEffect<void>("record_translation_history_completion", {
        input: {
          completionId: input.completionId,
          ok: input.ok,
          translatedText: input.translatedText,
          errorCode: input.errorCode,
          errorMessage: input.ok ? null : input.message,
          modelId: input.modelId,
          modelDisplayName: input.modelDisplayName,
          providerDisplayName: input.providerDisplayName,
          profileId: input.profileId,
          profileName: input.profileName,
          latencyMs: input.latencyMs,
          sourceLang: input.sourceLang,
          targetLang: input.targetLang,
          sourceText: input.sourceText,
          effectiveSourceLang: input.effectiveSourceLang,
          effectiveTargetLang: input.effectiveTargetLang,
        },
      }),
    );
  } catch {
    // Best-effort history write.
  }
}

function failureResult(
  errorCode: string,
  message: string,
  latencyMs: number,
  modelId?: string | null,
): TranslateResult {
  return {
    ok: false,
    translatedText: "",
    latencyMs,
    errorCode,
    message,
    modelId: modelId ?? null,
  };
}

function successResult(text: string, latencyMs: number, modelId: string): TranslateResult {
  return {
    ok: true,
    translatedText: text,
    latencyMs,
    errorCode: null,
    message: "OK",
    modelId,
  };
}

export async function runTranslationNonStream(
  input: TranslateInput,
  snapshots: TranslationContextSnapshots,
  signal?: AbortSignal,
): Promise<TranslateResult> {
  const started = performance.now();
  const ctx = resolveTranslationContext(input, snapshots);
  if (ctx.earlyFailure) {
    return failureResult(ctx.earlyFailure.errorCode, ctx.earlyFailure.message, 0);
  }
  if (ctx.kind === "service_integration") {
    return runServiceTranslation(input, ctx, signal, started);
  }
  return runAttempts(input, ctx, snapshots, false, undefined, signal, started);
}

export async function runTranslationStream(
  input: TranslateInput,
  snapshots: TranslationContextSnapshots,
  requestId: string,
  handlers: TranslationStreamHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const started = performance.now();
  const ctx = resolveTranslationContext(input, snapshots);
  if (ctx.earlyFailure) {
    handlers.onError(failureResult(ctx.earlyFailure.errorCode, ctx.earlyFailure.message, 0));
    return;
  }
  if (ctx.kind === "service_integration") {
    // Unary service call: onReset then one terminal onDone/onError (no fake chunks).
    // Pass a human label (never profile UUID) so UI does not render opaque ids.
    const serviceLabel = ctx.integrationDisplayName || ctx.capabilityLabel;
    handlers.onReset(serviceLabel);
    const result = await runServiceTranslation(input, ctx, signal, started, requestId);
    if (result.ok) {
      handlers.onDone(result);
    } else if (result.errorCode === "cancelled") {
      return;
    } else {
      handlers.onError(result);
    }
    return;
  }
  const result = await runAttempts(input, ctx, snapshots, true, handlers, signal, started, requestId);
  if (result.ok) {
    handlers.onDone(result);
  } else if (result.errorCode === "cancelled") {
    // Cancellation: no terminal success/error callback contract for abandoned work.
    return;
  } else {
    handlers.onError(result);
  }
}

/** Concrete app language id for service Translate IPC (never `auto` or display labels). */
const AUTO_LANGUAGE_ID = "auto";

/**
 * Service Translate IPC must receive concrete app language IDs only.
 * UI Auto is resolved upstream (detect source / LLM target Auto rules) into effective* fields.
 */
function resolveServiceRuntimeLanguageIds(
  input: TranslateInput,
): { sourceLang: string; targetLang: string } | { errorCode: string; message: string } {
  const sourceLang = input.effectiveSourceLangId?.trim() ?? "";
  const targetLang = input.effectiveTargetLangId?.trim() ?? "";
  if (!sourceLang || sourceLang.toLowerCase() === AUTO_LANGUAGE_ID) {
    return {
      errorCode: "validation_failed",
      message: "Concrete source language id is required for service translation",
    };
  }
  if (!targetLang || targetLang.toLowerCase() === AUTO_LANGUAGE_ID) {
    return {
      errorCode: "validation_failed",
      message: "Concrete target language id is required for service translation",
    };
  }
  return { sourceLang, targetLang };
}

async function runServiceTranslation(
  input: TranslateInput,
  ctx: ServiceTranslationExecutionContext,
  signal: AbortSignal | undefined,
  started: number,
  requestId?: string,
): Promise<TranslateResult> {
  if (signal?.aborted) {
    return failureResult("cancelled", "Request cancelled", Math.round(performance.now() - started));
  }
  const languages = resolveServiceRuntimeLanguageIds(input);
  if ("errorCode" in languages) {
    return failureResult(languages.errorCode, languages.message, Math.round(performance.now() - started));
  }
  const completionId = crypto.randomUUID();
  const rid = requestId ?? newClientRequestId("svc");
  try {
    const result = await runStorage(
      invokeEffect<TranslateResult>("translate_service_profile", {
        input: {
          requestId: rid,
          profileId: ctx.profileId,
          text: input.text,
          // Concrete app language IDs only — never UI labels or `auto`.
          sourceLang: languages.sourceLang,
          targetLang: languages.targetLang,
        },
      }),
    );
    if (signal?.aborted || result.errorCode === "cancelled") {
      return failureResult("cancelled", "Request cancelled", Math.round(performance.now() - started));
    }
    if (result.ok) {
      await recordHistoryBestEffort({
        completionId,
        ok: true,
        translatedText: result.translatedText,
        errorCode: null,
        message: result.message,
        modelId: null,
        modelDisplayName: ctx.capabilityLabel,
        providerDisplayName: ctx.integrationDisplayName,
        profileId: ctx.profileId,
        profileName: ctx.profileName,
        latencyMs: result.latencyMs,
        // History keeps UI labels when present; effective ids track concrete runtime languages.
        sourceLang: input.sourceLang,
        targetLang: input.targetLang,
        sourceText: input.text,
        effectiveSourceLang: languages.sourceLang,
        effectiveTargetLang: languages.targetLang,
      });
    }
    return { ...result, modelId: null };
  } catch (error) {
    if (signal?.aborted) {
      return failureResult("cancelled", "Request cancelled", Math.round(performance.now() - started));
    }
    const normalized = normalizeProviderError(error);
    return failureResult(normalized.code, normalized.message, Math.round(performance.now() - started), null);
  }
}

async function runAttempts(
  input: TranslateInput,
  ctx: LlmTranslationExecutionContext,
  _snapshots: TranslationContextSnapshots,
  stream: boolean,
  handlers: TranslationStreamHandlers | undefined,
  signal: AbortSignal | undefined,
  started: number,
  parentRequestId?: string,
): Promise<TranslateResult> {
  let lastFailure: TranslateResult | null = null;
  let attempted = false;
  const completionId = crypto.randomUUID();

  for (let index = 0; index < ctx.attempts.length; index += 1) {
    if (signal?.aborted) {
      return failureResult("cancelled", "Request cancelled", Math.round(performance.now() - started));
    }
    const attempt = ctx.attempts[index]!;
    if (stream && handlers && index > 0) {
      handlers.onReset(attempt.modelId);
    }
    attempted = true;
    const requestId = parentRequestId && index === 0 ? parentRequestId : newClientRequestId("tr");
    const chatInput: ExecutorChatInput = {
      operation: "translate",
      stream,
      modelKey: attempt.modelKey,
      systemPrompt: ctx.systemPrompt,
      userPrompt: ctx.userPrompt,
      temperature: attempt.temperature,
      maxTokens: attempt.maxTokens,
      thinking: attempt.thinking,
      imagePngBase64: null,
    };
    try {
      if (!stream) {
        const response = await attempt.executor.chat({ ...chatInput, requestId, signal });
        const result = successResult(response.text, Math.round(performance.now() - started), attempt.modelId);
        await recordHistoryBestEffort({
          completionId,
          ok: true,
          translatedText: result.translatedText,
          errorCode: null,
          message: result.message,
          modelId: attempt.modelId,
          modelDisplayName: attempt.modelDisplayName,
          providerDisplayName: attempt.providerDisplayName,
          profileId: ctx.profileId,
          profileName: ctx.profileName,
          latencyMs: result.latencyMs,
          sourceLang: input.sourceLang,
          targetLang: input.targetLang,
          sourceText: input.text,
          effectiveSourceLang: input.effectiveSourceLangId ?? null,
          effectiveTargetLang: input.effectiveTargetLangId ?? null,
        });
        return result;
      }

      // Stream path: typed executor deltas; provider-reported errors surface as provider_error.
      let accumulated = "";
      let streamErrorMessage: string | null = null;
      await attempt.executor.chatStream(
        { ...chatInput, requestId, signal },
        {
          onDelta: (text) => {
            accumulated += text;
            handlers?.onChunk(text);
          },
          onProviderError: (message) => {
            if (streamErrorMessage == null) {
              streamErrorMessage = message;
            }
          },
        },
      );

      if (streamErrorMessage != null) {
        // Surface provider stream errors to the UI toast via provider_error.
        // Try the next fallback model when available.
        lastFailure = failureResult(
          "provider_error",
          streamErrorMessage,
          Math.round(performance.now() - started),
          attempt.modelId,
        );
        continue;
      }
      const trimmed = accumulated.trim();
      if (!trimmed) {
        lastFailure = failureResult(
          "invalid_response",
          "Empty stream content",
          Math.round(performance.now() - started),
          attempt.modelId,
        );
        continue;
      }
      const result = successResult(trimmed, Math.round(performance.now() - started), attempt.modelId);
      await recordHistoryBestEffort({
        completionId,
        ok: true,
        translatedText: result.translatedText,
        errorCode: null,
        message: result.message,
        modelId: attempt.modelId,
        modelDisplayName: attempt.modelDisplayName,
        providerDisplayName: attempt.providerDisplayName,
        profileId: ctx.profileId,
        profileName: ctx.profileName,
        latencyMs: result.latencyMs,
        sourceLang: input.sourceLang,
        targetLang: input.targetLang,
        sourceText: input.text,
        effectiveSourceLang: input.effectiveSourceLangId ?? null,
        effectiveTargetLang: input.effectiveTargetLangId ?? null,
      });
      return result;
    } catch (error) {
      if (signal?.aborted) {
        return failureResult(
          "cancelled",
          "Request cancelled",
          Math.round(performance.now() - started),
          attempt.modelId,
        );
      }
      const normalized = normalizeProviderError(error);
      lastFailure = failureResult(
        normalized.code,
        normalized.message,
        Math.round(performance.now() - started),
        attempt.modelId,
      );
      // A runtime error advances only the existing configured next-model fallback after the
      // attempt ends; it is never replayed through the same provider's legacy executor.
      if (!normalized.retryable) {
        break;
      }
    }
  }

  const finalFailure =
    lastFailure ??
    failureResult(
      "validation_failed",
      attempted ? "All translation attempts failed" : "No translation attempt ran",
      Math.round(performance.now() - started),
    );
  if (attempted && finalFailure.errorCode !== "cancelled") {
    await recordHistoryBestEffort({
      completionId,
      ok: false,
      translatedText: "",
      errorCode: finalFailure.errorCode ?? "invalid_response",
      message: finalFailure.message,
      modelId: finalFailure.modelId ?? null,
      modelDisplayName:
        ctx.attempts.find((a) => a.modelId === finalFailure.modelId)?.modelDisplayName ??
        finalFailure.modelId ??
        "unknown",
      providerDisplayName: ctx.attempts.find((a) => a.modelId === finalFailure.modelId)?.providerDisplayName ?? null,
      profileId: ctx.profileId,
      profileName: ctx.profileName,
      latencyMs: finalFailure.latencyMs,
      sourceLang: input.sourceLang,
      targetLang: input.targetLang,
      sourceText: input.text,
      effectiveSourceLang: input.effectiveSourceLangId ?? null,
      effectiveTargetLang: input.effectiveTargetLangId ?? null,
    });
  }
  return finalFailure;
}
