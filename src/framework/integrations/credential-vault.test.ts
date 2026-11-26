import { expect, test } from "nsh/test";
import { createCredentialVault } from "./credential-vault";

function memoryStorage(initial: Record<string, string> = {}) {
  const backing: Record<string, string> = { ...initial };
  return {
    backing,
    storage: {
      getItem: async (key: string) => backing[key] ?? null,
      setItem: async (key: string, value: string) => {
        backing[key] = value;
      },
      removeItem: async (key: string) => {
        delete backing[key];
      },
    },
  };
}

function exampleVault() {
  const memory = memoryStorage();
  return {
    ...memory,
    vault: createCredentialVault({ storage: memory.storage, namespace: "secret.tts" }),
  };
}

test("credential vault: stores a record under the namespace and reads it back", async () => {
  const { backing, vault } = exampleVault();

  const ref = await vault.put({ apiKey: " sk-1 ", secretKey: "sec-2", blank: "  " });

  expect(typeof ref).toBe("string");
  expect(backing[`secret.tts.${ref}`]).toBe(JSON.stringify({ apiKey: "sk-1", secretKey: "sec-2" }));
  expect(await vault.read(ref)).toEqual({ apiKey: "sk-1", secretKey: "sec-2" });
  expect(await vault.read("other")).toBeNull();
});

test("credential vault: malformed or non-string records read as null", async () => {
  const { storage, vault } = exampleVault();
  await storage.setItem("secret.tts.bad-json", "{not json");
  await storage.setItem("secret.tts.bad-field", JSON.stringify({ apiKey: 42 }));

  expect(await vault.read("bad-json")).toBeNull();
  expect(await vault.read("bad-field")).toBeNull();
});

test("credential vault: removes only the addressed key", async () => {
  const { backing, storage, vault } = exampleVault();
  const ref = await vault.put({ apiKey: "sk-1" });
  await storage.setItem("secret.tts.keep", JSON.stringify({ apiKey: "other" }));

  await vault.remove(ref);

  expect(backing[`secret.tts.${ref}`]).toBeUndefined();
  expect(backing["secret.tts.keep"]).toBe(JSON.stringify({ apiKey: "other" }));
});

test("credential vault: a storage read failure rejects rather than returns null", async () => {
  const vault = createCredentialVault({
    storage: {
      getItem: async () => {
        throw new Error("disk offline");
      },
      setItem: async () => {},
      removeItem: async () => {},
    },
    namespace: "secret.tts",
  });

  let rejected = false;
  try {
    await vault.read("ref");
  } catch {
    rejected = true;
  }
  expect(rejected).toBe(true);
});
