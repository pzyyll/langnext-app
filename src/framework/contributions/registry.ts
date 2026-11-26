// ABOUTME: One registry for protocols, providers, presentations, and capability channels.
// ABOUTME: Registration checks identity; cross-axis consistency is reported by diagnostics().
import { t } from "nsh/i18n";
import type { ProtocolDefinition } from "../../modules/ai/contracts/protocol";
import type { ProviderDefinition } from "../../modules/ai/contracts/provider";
import type { ProviderPresentation } from "../../modules/ai/ui/contracts";
import type { CapabilityChannelContribution, CapabilityId, ContributionAxis } from "./contracts";

/** Raised when a contribution cannot be registered or looked up. */
export class ContributionError extends Error {
  readonly axis: ContributionAxis;
  readonly id: string;

  constructor(message: string, axis: ContributionAxis, id: string) {
    super(message);
    this.name = "ContributionError";
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
  axis: ContributionAxis;
  id: string;
  message: string;
}

/** The registered object for one axis. */
export type ContributionOf<A extends ContributionAxis> = A extends "protocol"
  ? ProtocolDefinition
  : A extends "provider"
    ? ProviderDefinition
    : A extends "provider-presentation"
      ? ProviderPresentation
      : CapabilityChannelContribution<unknown, unknown, unknown>;

/** Every contribution the app assembled, with lookup and consistency checks. */
export interface ContributionRegistry {
  registerProtocol(definition: ProtocolDefinition): void;
  registerProvider(definition: ProviderDefinition): void;
  registerPresentation(presentation: ProviderPresentation): void;
  registerCapability<C, In, Out>(contribution: CapabilityChannelContribution<C, In, Out>): void;
  get<A extends ContributionAxis>(axis: A, id: string): ContributionOf<A>;
  find<A extends ContributionAxis>(axis: A, id: string): ContributionOf<A> | null;
  /** Finds one capability channel by capability and id; channel ids repeat across capabilities. */
  findCapability(
    capability: CapabilityId,
    id: string,
  ): CapabilityChannelContribution<unknown, unknown, unknown> | null;
  list<A extends ContributionAxis>(axis: A): ContributionOf<A>[];
  capabilities(
    capability: CapabilityId,
  ): CapabilityChannelContribution<unknown, unknown, unknown>[];
  diagnostics(): Diagnostic[];
}

const CAPABILITY_IDS: readonly string[] = ["tts", "ocr", "detect"];

function blankId(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

function duplicate(axis: ContributionAxis, id: string): ContributionError {
  return new ContributionError(t("framework.contribution.duplicate", { axis, id }), axis, id);
}

function invalidId(axis: ContributionAxis, id: string): ContributionError {
  return new ContributionError(t("framework.contribution.invalidId", { axis, id }), axis, id);
}

function unknown(axis: ContributionAxis, id: string): ContributionError {
  return new ContributionError(t("framework.contribution.unknown", { axis, id }), axis, id);
}

type StoredCapability = CapabilityChannelContribution<unknown, unknown, unknown>;

interface CapabilityEntry {
  capability: string;
  contribution: StoredCapability;
}

/** Creates an empty registry. Callers register contributions explicitly. */
export function createContributionRegistry(): ContributionRegistry {
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
    contribution: CapabilityChannelContribution<C, In, Out>,
  ): void {
    const id = contribution.id;
    if (blankId(id)) throw invalidId("capability", String(id));
    if (
      capabilityEntries.some(
        (entry) => entry.capability === contribution.capability && entry.contribution.id === id,
      )
    ) {
      throw duplicate("capability", id);
    }
    capabilityEntries.push({
      capability: contribution.capability,
      contribution: contribution as unknown as StoredCapability,
    });
  }

  function findCapability(capability: CapabilityId, id: string): StoredCapability | null {
    for (const entry of capabilityEntries) {
      if (entry.capability === capability && entry.contribution.id === id)
        return entry.contribution;
    }
    return null;
  }

  function findAnyCapability(id: string): StoredCapability | null {
    for (const entry of capabilityEntries) {
      if (entry.contribution.id === id) return entry.contribution;
    }
    return null;
  }

  function find<A extends ContributionAxis>(axis: A, id: string): ContributionOf<A> | null {
    if (axis === "protocol") return (protocols.get(id) ?? null) as ContributionOf<A> | null;
    if (axis === "provider") return (providers.get(id) ?? null) as ContributionOf<A> | null;
    if (axis === "provider-presentation") {
      return (presentations.get(id) ?? null) as ContributionOf<A> | null;
    }
    return findAnyCapability(id) as ContributionOf<A> | null;
  }

  function get<A extends ContributionAxis>(axis: A, id: string): ContributionOf<A> {
    const found = find(axis, id);
    if (found === null) throw unknown(axis, id);
    return found;
  }

  function list<A extends ContributionAxis>(axis: A): ContributionOf<A>[] {
    if (axis === "protocol") return Array.from(protocols.values()) as ContributionOf<A>[];
    if (axis === "provider") return Array.from(providers.values()) as ContributionOf<A>[];
    if (axis === "provider-presentation") {
      return Array.from(presentations.values()) as ContributionOf<A>[];
    }
    return capabilityEntries.map((entry) => entry.contribution) as ContributionOf<A>[];
  }

  function capabilities(capability: CapabilityId): StoredCapability[] {
    return capabilityEntries
      .filter((entry) => entry.capability === capability)
      .map((entry) => entry.contribution);
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
          message: t("framework.contribution.invalidProvider", { id }),
        });
      }
      for (const protocolId of provider.allowedProtocolIds) {
        if (protocols.has(protocolId)) continue;
        found.push({
          code: "unknown_protocol",
          axis: "provider",
          id,
          message: t("framework.contribution.unknownProtocol", { id, protocol: protocolId }),
        });
      }
      if (!provider.allowedProtocolIds.includes(provider.defaultProtocolId)) {
        found.push({
          code: "invalid_provider",
          axis: "provider",
          id,
          message: t("framework.contribution.invalidProvider", { id }),
        });
      }
      const catalogProtocolId = provider.catalogProtocolId;
      if (catalogProtocolId != null && !protocols.has(catalogProtocolId)) {
        found.push({
          code: "unknown_protocol",
          axis: "provider",
          id,
          message: t("framework.contribution.unknownProtocol", {
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
          message: t("framework.contribution.missingPresentation", { id }),
        });
      }
    }

    for (const providerTypeId of presentations.keys()) {
      if (providers.has(providerTypeId)) continue;
      found.push({
        code: "unknown_provider",
        axis: "provider-presentation",
        id: providerTypeId,
        message: t("framework.contribution.unknownProvider", { id: providerTypeId }),
      });
    }

    for (const entry of capabilityEntries) {
      if (CAPABILITY_IDS.includes(entry.capability)) continue;
      const id = entry.contribution.id;
      found.push({
        code: "invalid_capability",
        axis: "capability",
        id,
        message: t("framework.contribution.invalidCapability", {
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

let productionRegistry: ContributionRegistry = createContributionRegistry();

/** The registry startup assembly populated; feature stores read it through this accessor. */
export function getContributionRegistry(): ContributionRegistry {
  return productionRegistry;
}

/** Replaces the production registry; isolated tests use it to start from an empty instance. */
export function setContributionRegistry(registry: ContributionRegistry | null): void {
  productionRegistry = registry ?? createContributionRegistry();
}
