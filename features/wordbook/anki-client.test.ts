import { expect, test } from "nsh/test";
import type { HttpRequestInit } from "../../services/http";
import { createAnkiClient } from "./anki-client";

const ENDPOINT = "http://127.0.0.1:8765/api/v1";

interface RpcBody {
  jsonrpc: string;
  id: unknown;
  method: string;
  params: Record<string, unknown>;
}

function json(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => body,
  };
}

function header(headers: Record<string, string>, name: string): string | undefined {
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return found?.[1];
}

test("anki read: lists the open profile, normal decks, and note types", async () => {
  const calls: { url: string; init: HttpRequestInit }[] = [];
  const client = createAnkiClient({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const request = JSON.parse(init.body ?? "") as RpcBody;
      if (request.method === "collection.get") {
        return json({
          jsonrpc: "2.0",
          id: request.id,
          result: { profile: "User 1", session: "sess-1", scheduler: "fsrs" },
        });
      }
      if (request.method === "decks.list") {
        return json({
          jsonrpc: "2.0",
          id: request.id,
          result: [
            { id: "1550000000000", name: "Vocabulary", kind: "normal", presetId: "1" },
            { id: "1550000000001", name: "Filtered", kind: "filtered", presetId: null },
          ],
        });
      }
      if (request.method === "noteTypes.list") {
        return json({
          jsonrpc: "2.0",
          id: request.id,
          result: [
            { id: "1550000000002", name: "Basic" },
            { id: "1550000000003", name: "基础" },
          ],
        });
      }
      return json({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Unknown method.", data: { type: "methodNotFound" } },
      });
    },
  });

  const found = await client.discover();

  expect(found).toEqual({
    ok: true,
    profile: "User 1",
    session: "sess-1",
    decks: [{ id: "1550000000000", name: "Vocabulary" }],
    noteTypes: [
      { id: "1550000000002", name: "Basic" },
      { id: "1550000000003", name: "基础" },
    ],
  });
  expect(calls.map((call) => call.url)).toEqual([ENDPOINT, ENDPOINT, ENDPOINT]);
  const bodies = calls.map((call) => JSON.parse(call.init.body ?? "") as RpcBody);
  const byMethod = new Map(bodies.map((body) => [body.method, body]));
  expect([...byMethod.keys()].sort()).toEqual(["collection.get", "decks.list", "noteTypes.list"]);
  expect(byMethod.get("collection.get")?.params).toEqual({});
  expect(byMethod.get("decks.list")?.params).toEqual({ session: "sess-1" });
  expect(byMethod.get("noteTypes.list")?.params).toEqual({ session: "sess-1" });
  expect(
    bodies.every((body) => body.jsonrpc === "2.0" && body.id !== null && body.id !== undefined),
  ).toBe(true);
  expect(
    calls.every(
      (call) =>
        call.init.method === "POST" &&
        call.init.redirect === "error" &&
        header(call.init.headers, "content-type") === "application/json" &&
        header(call.init.headers, "origin") === undefined &&
        header(call.init.headers, "authorization") === undefined,
    ),
  ).toBe(true);
});

test("anki read: reads ordered fields for a non-English note type", async () => {
  const calls: { url: string; init: HttpRequestInit }[] = [];
  const client = createAnkiClient({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      const request = JSON.parse(init.body ?? "") as RpcBody;
      return json({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          id: "1550000000003",
          name: "基础",
          kind: "normal",
          fields: [{ name: "正面" }, { name: "背面" }, { name: "例句" }],
          templates: [
            {
              name: "卡片 1",
              questionHtml: "{{正面}}",
              answerHtml: "{{背面}}",
              deck: null,
            },
          ],
          css: "",
          sortField: "正面",
          latexHeader: "",
          latexFooter: "",
          latexSvg: false,
          modifiedAt: "2026-11-25T00:00:00.000Z",
        },
      });
    },
  });

  const found = await client.getNoteType("sess-1", "1550000000003");

  expect(found).toEqual({
    ok: true,
    id: "1550000000003",
    name: "基础",
    kind: "normal",
    fields: ["正面", "背面", "例句"],
    templateCount: 1,
    hasDeckOverride: false,
  });
  expect(calls.map((call) => call.url)).toEqual([ENDPOINT]);
  const body = JSON.parse(calls[0]?.init.body ?? "") as RpcBody;
  expect(body.method).toBe("noteTypes.get");
  expect(body.params).toEqual({
    noteType: { id: "1550000000003" },
    session: "sess-1",
  });
});

function statusReply(status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => {
      throw new Error("transport rejection has no JSON body");
    },
  };
}

test("anki read: reports a refused connection without logging the transport error", async () => {
  const errorLines: string[] = [];
  const original = console.error;
  console.error = (...data: unknown[]) => {
    errorLines.push(data.map(String).join(" "));
  };
  const client = createAnkiClient({
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  try {
    const found = await client.discover();
    expect(found).toEqual({ ok: false, failure: "unreachable" });
    expect(errorLines.join("\n")).not.toContain("fetch failed");
  } finally {
    console.error = original;
  }
});

test("anki read: reports unauthorized and forbidden before reading a body", async () => {
  const unauthorized = createAnkiClient({
    apiKey: "test-key",
    fetchImpl: async (_url, init) => {
      expect(header(init.headers, "authorization")).toBe("Bearer test-key");
      expect(header(init.headers, "origin")).toBeUndefined();
      return statusReply(401);
    },
  });
  const forbidden = createAnkiClient({
    fetchImpl: async () => statusReply(403),
  });
  expect(await unauthorized.discover()).toEqual({ ok: false, failure: "unauthorized" });
  expect(await forbidden.discover()).toEqual({ ok: false, failure: "forbidden" });
});

test("anki read: reports a missing or legacy v1 endpoint as unavailable", async () => {
  const missing = createAnkiClient({
    fetchImpl: async () => statusReply(404),
  });
  const legacy = createAnkiClient({
    fetchImpl: async () => json({ result: 6, error: null }),
  });
  expect(await missing.discover()).toEqual({ ok: false, failure: "unavailable" });
  expect(await legacy.discover()).toEqual({ ok: false, failure: "unavailable" });
});

test("anki read: reports no open collection and a stale session", async () => {
  const methods: string[] = [];
  const closed = createAnkiClient({
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body ?? "") as RpcBody;
      methods.push(request.method);
      return json({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: 1004,
          message: "No collection is open.",
          data: { type: "collectionUnavailable" },
        },
      });
    },
  });
  const stale = createAnkiClient({
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body ?? "") as RpcBody;
      if (request.method === "collection.get") {
        return json({
          jsonrpc: "2.0",
          id: request.id,
          result: { profile: "User 1", session: "sess-1", scheduler: "fsrs" },
        });
      }
      return json({
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: 1005,
          message: "Session changed.",
          data: { type: "staleSession" },
        },
      });
    },
  });
  expect(await closed.discover()).toEqual({ ok: false, failure: "noCollection" });
  expect(methods).toEqual(["collection.get"]);
  expect(await stale.discover()).toEqual({ ok: false, failure: "staleSession" });
});

test("anki read: reports a mismatched reply as malformed", async () => {
  const client = createAnkiClient({
    fetchImpl: async () =>
      json({
        jsonrpc: "2.0",
        id: "other",
        result: { profile: "User 1", session: "sess-1", scheduler: "fsrs" },
      }),
  });
  expect(await client.discover()).toEqual({ ok: false, failure: "malformed" });
});

test("anki read: times out while reading JSON", async () => {
  const client = createAnkiClient({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: () => new Promise(() => {}),
    }),
  });
  expect(await client.discover()).toEqual({ ok: false, failure: "timeout" });
});
