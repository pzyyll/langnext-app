import { mount, signal, Text, View } from "nsh";
import { initializeAiModules } from "../../../../app/ai-setup";
import { aiClient } from "../client";

initializeAiModules();

function RedirectApp() {
  const status = signal("running");
  const detail = signal("");

  void (async () => {
    let caught: unknown = null;
    try {
      await aiClient.generateText(
        {
          providerTypeId: "custom",
          protocolId: "openai-compatible",
          baseUrl: "http://127.0.0.1:41234/v1",
          credential: "sk-loopback-secret",
        },
        { modelId: "gpt-4.1", system: "Translate", user: "Hello" },
      );
    } catch (error) {
      caught = error;
    }

    const err = caught as { name?: string; kind?: string; message?: string } | null;
    const safe =
      err !== null &&
      err.name === "ProviderProtocolError" &&
      err.kind === "network" &&
      typeof err.message === "string" &&
      !err.message.includes("sk-loopback-secret") &&
      !err.message.includes("127.0.0.1");
    detail.set(`${err?.kind ?? "none"}|${err?.message ?? ""}`);
    status.set(safe ? "rejected" : "unexpected");
  })();

  return (
    <View class="p-4">
      <Text testID="redirect-status">{status()}</Text>
      <Text testID="redirect-detail">{detail()}</Text>
    </View>
  );
}

mount(RedirectApp);
