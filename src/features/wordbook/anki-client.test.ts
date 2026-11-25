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

const SAVED_TARGET = {
  profile: "User 1",
  deckId: "1550000000000",
  noteTypeId: "1550000000003",
  sourceField: "正面",
  translationField: "背面",
};

test("anki add: creates one escaped note for the saved target", async () => {
  const methods: string[] = [];
  const calls: HttpRequestInit[] = [];
  const client = createAnkiClient({
    fetchImpl: async (_url, init) => {
      calls.push(init);
      const request = JSON.parse(init.body ?? "") as RpcBody;
      methods.push(request.method);
      if (request.method === "collection.get") {
        return json({
          jsonrpc: "2.0",
          id: request.id,
          result: { profile: "User 1", session: "sess-9", scheduler: "fsrs" },
        });
      }
      if (request.method === "decks.get") {
        return json({
          jsonrpc: "2.0",
          id: request.id,
          result: { id: "1550000000000", name: "Vocabulary", kind: "normal", presetId: "1" },
        });
      }
      if (request.method === "noteTypes.get") {
        return json({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            id: "1550000000003",
            name: "基础",
            kind: "normal",
            fields: [{ name: "正面" }, { name: "背面" }, { name: "例句" }],
            templates: [
              { name: "卡片 1", questionHtml: "{{正面}}", answerHtml: "{{背面}}", deck: null },
            ],
            css: "",
            sortField: "正面",
            latexHeader: "",
            latexFooter: "",
            latexSvg: false,
            modifiedAt: "2026-11-25T00:00:00.000Z",
          },
        });
      }
      if (request.method === "notes.create") {
        return json({
          jsonrpc: "2.0",
          id: request.id,
          result: { noteId: "1550000000099", cardIds: ["1550000000100"] },
        });
      }
      return json({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32601, message: "Unknown method.", data: { type: "methodNotFound" } },
      });
    },
  });

  const found = await client.addTranslation({
    target: SAVED_TARGET,
    sourceText: "A < B\nC & D",
    translatedText: "第一行\n第二行",
    isCurrent: () => {
      methods.push("current");
      return true;
    },
  });

  expect(found).toEqual({ ok: true, outcome: "added" });
  expect(methods).toEqual([
    "collection.get",
    "decks.get",
    "noteTypes.get",
    "current",
    "notes.create",
  ]);
  const bodies = calls.map((call) => JSON.parse(call.body ?? "") as RpcBody);
  expect(bodies.map((body) => body.method)).toEqual([
    "collection.get",
    "decks.get",
    "noteTypes.get",
    "notes.create",
  ]);
  expect(bodies[1]?.params).toEqual({ deck: { id: "1550000000000" }, session: "sess-9" });
  expect(bodies[2]?.params).toEqual({ noteType: { id: "1550000000003" }, session: "sess-9" });
  expect(bodies[3]?.params).toEqual({
    deck: { id: "1550000000000" },
    noteType: { id: "1550000000003" },
    fields: {
      正面: "A &lt; B<br>C &amp; D",
      背面: "第一行<br>第二行",
      例句: "",
    },
    session: "sess-9",
    duplicates: {
      allow: false,
      scope: "deck",
      deck: { id: "1550000000000" },
      includeChildren: false,
      acrossNoteTypes: false,
    },
  });
  expect(
    calls.filter((call) => (JSON.parse(call.body ?? "") as RpcBody).method === "notes.create"),
  ).toHaveLength(1);
});

function rpcOk(id: unknown, result: unknown) {
  return json({ jsonrpc: "2.0", id, result });
}

function rpcErr(id: unknown, error: unknown) {
  return json({ jsonrpc: "2.0", id, error });
}

function noteTypeBody(deck: unknown = null, fields = ["正面", "背面", "例句"]) {
  return {
    id: "1550000000003",
    name: "基础",
    kind: "normal",
    fields: fields.map((name) => ({ name })),
    templates: [{ name: "卡片 1", questionHtml: "{{正面}}", answerHtml: "{{背面}}", deck }],
    css: "",
    sortField: fields[0],
    latexHeader: "",
    latexFooter: "",
    latexSvg: false,
    modifiedAt: "2026-11-25T00:00:00.000Z",
  };
}

function addHarness(
  route: (request: RpcBody) => {
    ok: boolean;
    status: number;
    headers: { get: () => string | null };
    json: () => Promise<unknown>;
  },
) {
  const methods: string[] = [];
  const client = createAnkiClient({
    fetchImpl: async (_url, init) => {
      const request = JSON.parse(init.body ?? "") as RpcBody;
      methods.push(request.method);
      return route(request);
    },
  });
  return { client, methods };
}

function savedAdd(route: (request: RpcBody) => ReturnType<typeof rpcOk>, isCurrent = () => true) {
  const harness = addHarness((request) => {
    if (request.method === "collection.get") {
      return rpcOk(request.id, { profile: "User 1", session: "sess-9", scheduler: "fsrs" });
    }
    if (request.method === "decks.get") {
      return rpcOk(request.id, {
        id: "1550000000000",
        name: "Vocabulary",
        kind: "normal",
        presetId: "1",
      });
    }
    if (request.method === "noteTypes.get") return rpcOk(request.id, noteTypeBody());
    return route(request);
  });
  const pending = harness.client.addTranslation({
    target: SAVED_TARGET,
    sourceText: "A < B",
    translatedText: "第一行",
    isCurrent,
  });
  return { ...harness, pending };
}

const DUPLICATE_ERROR = {
  code: 1002,
  message: "Note cannot be created.",
  data: {
    type: "validationFailed",
    details: {
      valid: false,
      issues: [{ type: "duplicate", message: "A matching note exists." }],
      duplicateNoteIds: ["1550000000011"],
    },
  },
};

test("anki add: reports a duplicate without changing the existing note", async () => {
  const { methods, pending } = savedAdd((request) => rpcErr(request.id, DUPLICATE_ERROR));
  expect(await pending).toEqual({ ok: false, failure: "duplicate" });
  expect(methods.filter((method) => method === "notes.create")).toHaveLength(1);
  expect(methods).not.toContain("notes.update");
});

test("anki add: does not write when the profile, fields, template, or enablement changed", async () => {
  const mismatch = addHarness((request) => {
    if (request.method === "collection.get") {
      return rpcOk(request.id, { profile: "Other", session: "sess-9", scheduler: "fsrs" });
    }
    throw new Error(request.method);
  });
  const missingField = addHarness((request) => {
    if (request.method === "collection.get") {
      return rpcOk(request.id, { profile: "User 1", session: "sess-9", scheduler: "fsrs" });
    }
    if (request.method === "decks.get") {
      return rpcOk(request.id, {
        id: "1550000000000",
        name: "Vocabulary",
        kind: "normal",
        presetId: "1",
      });
    }
    if (request.method === "noteTypes.get")
      return rpcOk(request.id, noteTypeBody(null, ["正面", "例句"]));
    throw new Error(request.method);
  });
  const override = addHarness((request) => {
    if (request.method === "collection.get") {
      return rpcOk(request.id, { profile: "User 1", session: "sess-9", scheduler: "fsrs" });
    }
    if (request.method === "decks.get") {
      return rpcOk(request.id, {
        id: "1550000000000",
        name: "Vocabulary",
        kind: "normal",
        presetId: "1",
      });
    }
    if (request.method === "noteTypes.get") {
      return rpcOk(request.id, noteTypeBody({ id: "1550000000000" }));
    }
    throw new Error(request.method);
  });
  const disabled = savedAdd(
    (request) => {
      throw new Error(request.method);
    },
    () => false,
  );
  const pair = {
    target: SAVED_TARGET,
    sourceText: "A < B",
    translatedText: "第一行",
    isCurrent: () => true,
  };
  expect(await mismatch.client.addTranslation(pair)).toEqual({
    ok: false,
    failure: "profileMismatch",
  });
  expect(await missingField.client.addTranslation(pair)).toEqual({
    ok: false,
    failure: "incompatible",
  });
  expect(await override.client.addTranslation(pair)).toEqual({
    ok: false,
    failure: "incompatible",
  });
  expect(await disabled.pending).toEqual({ ok: false, failure: "notCurrent" });
  expect(mismatch.methods).toEqual(["collection.get"]);
  expect(missingField.methods).not.toContain("notes.create");
  expect(override.methods).not.toContain("notes.create");
  expect(disabled.methods).not.toContain("notes.create");
});

test("anki add: does not write when the deck is missing or filtered", async () => {
  const open = { profile: "User 1", session: "sess-9", scheduler: "fsrs" };
  const missing = addHarness((request) => {
    if (request.method === "collection.get") return rpcOk(request.id, open);
    if (request.method === "decks.get") {
      return rpcErr(request.id, {
        code: 1001,
        message: "Deck not found.",
        data: { type: "notFound" },
      });
    }
    throw new Error(request.method);
  });
  const filtered = addHarness((request) => {
    if (request.method === "collection.get") return rpcOk(request.id, open);
    if (request.method === "decks.get") {
      return rpcOk(request.id, {
        id: "1550000000000",
        name: "Filtered",
        kind: "filtered",
        presetId: null,
      });
    }
    throw new Error(request.method);
  });
  const pair = {
    target: SAVED_TARGET,
    sourceText: "A < B",
    translatedText: "第一行",
    isCurrent: () => true,
  };
  expect(await missing.client.addTranslation(pair)).toEqual({
    ok: false,
    failure: "missingTarget",
  });
  expect(await filtered.client.addTranslation(pair)).toEqual({
    ok: false,
    failure: "incompatible",
  });
  expect(missing.methods).toEqual(["collection.get", "decks.get"]);
  expect(filtered.methods).toEqual(["collection.get", "decks.get"]);
});

test("anki add: rejects a blank pair before any request", async () => {
  const client = createAnkiClient({
    fetchImpl: async () => {
      throw new Error("blank pair must not call Anki");
    },
  });
  expect(
    await client.addTranslation({
      target: SAVED_TARGET,
      sourceText: "  ",
      translatedText: "第一行",
      isCurrent: () => true,
    }),
  ).toEqual({ ok: false, failure: "blank" });
});

test("anki add: leaves a lost or invalid create reply unconfirmed and does not retry", async () => {
  const mismatched = savedAdd(() =>
    rpcOk("other", { noteId: "1550000000099", cardIds: ["1550000000100"] }),
  );
  const internal = savedAdd((request) =>
    rpcErr(request.id, {
      code: -32603,
      message: "Internal API error.",
      data: { type: "internalError" },
    }),
  );
  const lost = savedAdd(() => {
    throw new TypeError("fetch failed");
  });
  const emptyCards = savedAdd((request) =>
    rpcOk(request.id, { noteId: "1550000000099", cardIds: [] }),
  );
  const rejected = savedAdd((request) =>
    rpcErr(request.id, {
      code: 1002,
      message: "Note cannot be created.",
      data: {
        type: "validationFailed",
        details: {
          valid: false,
          issues: [{ type: "emptyQuestions", message: "All generated questions are empty." }],
          duplicateNoteIds: [],
        },
      },
    }),
  );
  expect(await mismatched.pending).toEqual({ ok: false, failure: "unconfirmed" });
  expect(await internal.pending).toEqual({ ok: false, failure: "unconfirmed" });
  expect(await lost.pending).toEqual({ ok: false, failure: "unconfirmed" });
  expect(await emptyCards.pending).toEqual({ ok: false, failure: "unconfirmed" });
  expect(await rejected.pending).toEqual({ ok: false, failure: "rejected" });
  expect(mismatched.methods.filter((method) => method === "notes.create")).toHaveLength(1);
  expect(internal.methods.filter((method) => method === "notes.create")).toHaveLength(1);
  expect(lost.methods.filter((method) => method === "notes.create")).toHaveLength(1);
});

test("anki add: times out during create without retrying", async () => {
  const { methods, pending } = savedAdd(() => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: () => new Promise(() => {}),
  }));
  expect(await pending).toEqual({ ok: false, failure: "unconfirmed" });
  expect(methods.filter((method) => method === "notes.create")).toHaveLength(1);
});

test("anki add: keeps a refused read distinct from an unconfirmed write", async () => {
  const client = createAnkiClient({
    fetchImpl: async () => {
      throw new TypeError("fetch failed");
    },
  });
  expect(
    await client.addTranslation({
      target: SAVED_TARGET,
      sourceText: "A < B",
      translatedText: "第一行",
      isCurrent: () => true,
    }),
  ).toEqual({ ok: false, failure: "unreachable" });
});
