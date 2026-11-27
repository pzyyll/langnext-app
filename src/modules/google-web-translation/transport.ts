// ABOUTME: The shared form POST for Google Translate's undocumented `translate_a/t` endpoint.
// ABOUTME: One deadline covers the fetch and the body read; HTTP statuses map to protocol errors.
import { t } from "nsh/i18n";
import { DEFAULT_HTTP_TIMEOUT_MS } from "../ai/runtime/http";
import { ProviderProtocolError } from "../ai/contracts/errors";
import { createHttpFetch, type FetchLike } from "../../services/http";
import { createLogger } from "../../services/log";

/** Fixed endpoint; the translated text travels in the form body, never in the URL. */
export const GOOGLE_WEB_TRANSLATE_URL = "https://translate.googleapis.com/translate_a/t";

/** One form request: the source may be `auto` for detection, or a concrete wire code. */
export interface GoogleWebFormRequest {
  source: string;
  target: string;
  text: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface GoogleWebTransportOptions {
  /** Transport seam; defaults to the app's logging HTTP wrapper. */
  fetchImpl?: FetchLike;
  /** Log scope, `<area>/<module>`. */
  scope: string;
  /** Translation refuses redirects; detection keeps the default behavior. */
  redirect?: "follow" | "error";
  /** Set false to keep form bodies and response payloads out of the log. */
  logBodies?: boolean;
  /** Set false to log the failure category only, never the exception text. */
  logFailureDetail?: boolean;
}

export type GoogleWebTransport = (request: GoogleWebFormRequest) => Promise<unknown>;

function isTimeout(error: unknown): boolean {
  return error instanceof ProviderProtocolError && error.kind === "timeout";
}

function isCancelled(error: unknown): boolean {
  return error instanceof ProviderProtocolError && error.kind === "cancelled";
}

function cancelledError(): ProviderProtocolError {
  return new ProviderProtocolError("cancelled", t("protocol.error.cancelled"));
}

function timeoutError(): ProviderProtocolError {
  return new ProviderProtocolError("timeout", t("protocol.error.timeout"));
}

/** Maps an unsuccessful HTTP status onto the shared categories without keeping provider text. */
function statusError(status: number): ProviderProtocolError {
  if (status === 401 || status === 403) {
    return new ProviderProtocolError("auth", t("googleWeb.error.accessDenied"), status);
  }
  if (status === 429) {
    return new ProviderProtocolError("rate_limited", t("googleWeb.error.rateLimited"), status);
  }
  if (status >= 500) {
    return new ProviderProtocolError("server", t("googleWeb.error.server"), status);
  }
  if (status === 413) {
    return new ProviderProtocolError("invalid_request", t("googleWeb.error.tooLarge"), status);
  }
  return new ProviderProtocolError("invalid_request", t("googleWeb.error.rejected"), status);
}

/** Creates one transport; it performs no I/O until a request. */
export function createGoogleWebTransport(options: GoogleWebTransportOptions): GoogleWebTransport {
  const runFetch = createHttpFetch({
    fetchImpl: options.fetchImpl,
    scope: options.scope,
    logBodies: options.logBodies !== false,
    // The transport reports one sanitized line itself; the raw exception stays out.
    logFailures: false,
  });
  const log = createLogger(options.scope);

  const reportFailure = (error: ProviderProtocolError) => {
    if (error.kind === "cancelled") {
      log.debug("Google Web form request cancelled.");
      return;
    }
    if (options.logFailureDetail === false) {
      log.warn(`Google Web form request failed (${error.kind}).`);
      return;
    }
    log.error(`Google Web form request failed (${error.kind}).`, error);
  };

  return async (request) => {
    const externalSignal = request.signal;
    if (externalSignal?.aborted) throw cancelledError();

    const controller = new AbortController();
    let timedOut = false;
    let rejectCancel: (() => void) | null = null;
    let rejectTimeout: (() => void) | null = null;
    const interruptions: Array<Promise<never>> = [];

    if (externalSignal) {
      interruptions.push(
        new Promise<never>((_resolve, reject) => {
          rejectCancel = () => reject(cancelledError());
        }),
      );
    }
    interruptions.push(
      new Promise<never>((_resolve, reject) => {
        rejectTimeout = () => reject(timeoutError());
      }),
    );

    const onExternalAbort = () => {
      controller.abort();
      rejectCancel?.();
    };
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectTimeout?.();
    }, request.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS);

    const transportFailure = (error: unknown): ProviderProtocolError => {
      if (timedOut || isTimeout(error)) return timeoutError();
      if (externalSignal?.aborted || isCancelled(error)) return cancelledError();
      return new ProviderProtocolError("network", t("protocol.error.networkDefault"));
    };

    const url = `${GOOGLE_WEB_TRANSLATE_URL}?client=gtx&sl=${encodeURIComponent(request.source)}&tl=${encodeURIComponent(request.target)}`;

    try {
      let response;
      try {
        const fetchPromise = runFetch(url, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: `q=${encodeURIComponent(request.text)}`,
          ...(options.redirect ? { redirect: options.redirect } : {}),
          signal: controller.signal,
        });
        // A late fetch rejection must not surface after the race already settled.
        fetchPromise.catch(() => {});
        response = await Promise.race([fetchPromise, ...interruptions]);
      } catch (error) {
        throw transportFailure(error);
      }

      if (externalSignal?.aborted) throw cancelledError();
      if (timedOut) throw timeoutError();
      if (!response.ok) throw statusError(response.status);

      let payload: unknown;
      try {
        const jsonPromise = response.json();
        jsonPromise.catch(() => {});
        payload = await Promise.race([jsonPromise, ...interruptions]);
      } catch (error) {
        if (timedOut || isTimeout(error)) throw timeoutError();
        if (externalSignal?.aborted || isCancelled(error)) throw cancelledError();
        throw new ProviderProtocolError("invalid_response", t("googleWeb.error.invalidResponse"));
      }

      if (externalSignal?.aborted) throw cancelledError();
      return payload;
    } catch (error) {
      const failure = error instanceof ProviderProtocolError ? error : transportFailure(error);
      reportFailure(failure);
      throw failure;
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  };
}
