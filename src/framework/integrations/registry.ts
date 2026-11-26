// ABOUTME: One registry for protocols, providers, presentations, and capability channels.
// ABOUTME: Registration checks identity; cross-axis consistency is reported by diagnostics().
import { t } from "nsh/i18n";
import type { ProtocolDefinition } from "../../modules/ai/contracts/protocol";
import type { ProviderDefinition } from "../../modules/ai/contracts/provider";
import type { ProviderPresentation } from "../../modules/ai/ui/contracts";
import type { CapabilityChannelDefinition, CapabilityId, IntegrationAxis } from "./contracts";

/** Raised when a definition cannot be registered or looked up. */
export class IntegrationError extends Error {
  readonly axis: IntegrationAxis;
  readonly id: string;

  constructor(message: string, axis: IntegrationAxis, id: string) {
    super(message);
    this.name = "IntegrationError";
    this.axis = axis;
    this.id = id;
  }
}

/** One cross-axis inconsistency startup assembly must not ignore. */
export type DiagnosticCode =
  | "unknown_protocol"
  | "invalid_provider"
  | "missing_presentation"
  | "unknown_provider"
  | "invalid_capability";

export interface Diagnostic {
  code: DiagnosticCode;
  axis: IntegrationAxis;
  id: string;
  message: string;
}

/** The registered object for one axis. */
export type IntegrationOf<A extends IntegrationAxis> = A extends "protocol"
  ? ProtocolDefinition
  : A extends "provider"
    ? ProviderDefinition
    : A extends "provider-presentation"
      ? ProviderPresentation
      : CapabilityChannelDefinition<unknown, unknown, unknown>;

/** Every definition the app assembled, with lookup and consistency checks. */
export interface IntegrationRegistry {
  registerProtocol(definition: ProtocolDefinition): void;
  registerProvider(definition: ProviderDefinition): void;
  registerPresentation(presentation: ProviderPresentation): void;
  registerCapability<C, In, Out>(definition: CapabilityChannelDefinition<C, In, Out>): void;
  get<A extends IntegrationAxis>(axis: A, id: string): IntegrationOf<A>;
  find<A extends IntegrationAxis>(axis: A, id: string): IntegrationOf<A> | null;
  /** Finds one capability channel by capability and id; channel ids repeat across capabilities. */
  findCapability(
    capability: CapabilityId,
    id: string,
  ): CapabilityChannelDefinition<unknown, unknown, unknown> | null;
  list<A extends IntegrationAxis>(axis: A): IntegrationOf<A>[];
  capabilities(capability: CapabilityId): CapabilityChannelDefinition<unknown, unknown, unknown>[];
  diagnostics(): Diagnostic[];
}

const CAPABILITY_IDS: readonly string[] = ["tts", "ocr", "detect"];

function blankId(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

function duplicate(axis: IntegrationAxis, id: string): IntegrationError {
  return new IntegrationError(t("framework.integration.duplicate", { axis, id }), axis, id);
}

function invalidId(axis: IntegrationAxis, id: string): IntegrationError {
  return new IntegrationError(t("framework.integration.invalidId", { axis, id }), axis, id);
}

function unknown(axis: IntegrationAxis, id: string): IntegrationError {
  return new IntegrationError(t("framework.integration.unknown", { axis, id }), axis, id);
}

type StoredCapability = CapabilityChannelDefinition<unknown, unknown, unknown>;

interface CapabilityEntry {
  capability: string;
  definition: StoredCapability;
}

/** Creates an empty registry. Callers register definitions explicitly. */
export function createIntegrationRegistry(): IntegrationRegistry {
  const protocols = new Map<string, ProtocolDefinition>();
  const providers = new Map<string, ProviderDefinition>();
  const presentations = new Map<string, ProviderPresentation>();
  const capabilityEntries: CapabilityEntry[] = [];

  function registerProtocol(definition: ProtocolDefinition): void {
    const id = definition.id;
    if (blankId(id)) throw invalidId("protocol", String(id));
    if (protocols.has(id)) throw duplicate("protocol", id);
    protocols.set(id, definition);
  }

  function registerProvider(definition: ProviderDefinition): void {
    const id = definition.id;
    if (blankId(id)) throw invalidId("provider", String(id));
    if (providers.has(id)) throw duplicate("provider", id);
    providers.set(id, definition);
  }

  function registerPresentation(presentation: ProviderPresentation): void {
    const id = presentation.providerTypeId;
    if (blankId(id)) throw invalidId("provider-presentation", String(id));
    if (presentations.has(id)) throw duplicate("provider-presentation", id);
    presentations.set(id, presentation);
  }

  function registerCapability<C, In, Out>(
    definition: CapabilityChannelDefinition<C, In, Out>,
  ): void {
    const id = definition.id;
    if (blankId(id)) throw invalidId("capability", String(id));
    if (
      capabilityEntries.some(
        (entry) => entry.capability === definition.capability && entry.definition.id === id,
      )
    ) {
      throw duplicate("capability", id);
    }
    capabilityEntries.push({
      capability: definition.capability,
      definition: definition as unknown as StoredCapability,
    });
  }

  function findCapability(capability: CapabilityId, id: string): StoredCapability | null {
    for (const entry of capabilityEntries) {
      if (entry.capability === capability && entry.definition.id === id) return entry.definition;
    }
    return null;
  }

  function findAnyCapability(id: string): StoredCapability | null {
    for (const entry of capabilityEntries) {
      if (entry.definition.id === id) return entry.definition;
    }
    return null;
  }

  function find<A extends IntegrationAxis>(axis: A, id: string): IntegrationOf<A> | null {
    if (axis === "protocol") return (protocols.get(id) ?? null) as IntegrationOf<A> | null;
    if (axis === "provider") return (providers.get(id) ?? null) as IntegrationOf<A> | null;
    if (axis === "provider-presentation") {
      return (presentations.get(id) ?? null) as IntegrationOf<A> | null;
    }
    return findAnyCapability(id) as IntegrationOf<A> | null;
  }

  function get<A extends IntegrationAxis>(axis: A, id: string): IntegrationOf<A> {
    const found = find(axis, id);
    if (found === null) throw unknown(axis, id);
    return found;
  }

  function list<A extends IntegrationAxis>(axis: A): IntegrationOf<A>[] {
    if (axis === "protocol") return Array.from(protocols.values()) as IntegrationOf<A>[];
    if (axis === "provider") return Array.from(providers.values()) as IntegrationOf<A>[];
    if (axis === "provider-presentation") {
      return Array.from(presentations.values()) as IntegrationOf<A>[];
    }
    return capabilityEntries.map((entry) => entry.definition) as IntegrationOf<A>[];
  }

  function capabilities(capability: CapabilityId): StoredCapability[] {
    return capabilityEntries
      .filter((entry) => entry.capability === capability)
      .map((entry) => entry.definition);
  }

  function diagnostics(): Diagnostic[] {
    const found: Diagnostic[] = [];

    for (const provider of providers.values()) {
      const id = provider.id;
      if (provider.allowedProtocolIds.length === 0) {
        found.push({
          code: "invalid_provider",
          axis: "provider",
          id,
          message: t("framework.integration.invalidProvider", { id }),
        });
      }
      for (const protocolId of provider.allowedProtocolIds) {
        if (protocols.has(protocolId)) continue;
        found.push({
          code: "unknown_protocol",
          axis: "provider",
          id,
          message: t("framework.integration.unknownProtocol", { id, protocol: protocolId }),
        });
      }
      if (!provider.allowedProtocolIds.includes(provider.defaultProtocolId)) {
        found.push({
          code: "invalid_provider",
          axis: "provider",
          id,
          message: t("framework.integration.invalidProvider", { id }),
        });
      }
      const catalogProtocolId = provider.catalogProtocolId;
      if (catalogProtocolId != null && !protocols.has(catalogProtocolId)) {
        found.push({
          code: "unknown_protocol",
          axis: "provider",
          id,
          message: t("framework.integration.unknownProtocol", {
            id,
            protocol: catalogProtocolId,
          }),
        });
      }
      if (!presentations.has(id)) {
        found.push({
          code: "missing_presentation",
          axis: "provider-presentation",
          id,
          message: t("framework.integration.missingPresentation", { id }),
        });
      }
    }

    for (const providerTypeId of presentations.keys()) {
      if (providers.has(providerTypeId)) continue;
      found.push({
        code: "unknown_provider",
        axis: "provider-presentation",
        id: providerTypeId,
        message: t("framework.integration.unknownProvider", { id: providerTypeId }),
      });
    }

    for (const entry of capabilityEntries) {
      if (CAPABILITY_IDS.includes(entry.capability)) continue;
      const id = entry.definition.id;
      found.push({
        code: "invalid_capability",
        axis: "capability",
        id,
        message: t("framework.integration.invalidCapability", {
          id,
          capability: entry.capability,
        }),
      });
    }

    return found;
  }

  return {
    registerProtocol,
    registerProvider,
    registerPresentation,
    registerCapability,
    get,
    find,
    findCapability,
    list,
    capabilities,
    diagnostics,
  };
}

let productionRegistry: IntegrationRegistry = createIntegrationRegistry();

/** The registry startup assembly populated; feature stores read it through this accessor. */
export function getIntegrationRegistry(): IntegrationRegistry {
  return productionRegistry;
}

/** Replaces the production registry; isolated tests use it to start from an empty instance. */
export function setIntegrationRegistry(registry: IntegrationRegistry | null): void {
  productionRegistry = registry ?? createIntegrationRegistry();
}
