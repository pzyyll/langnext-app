// ABOUTME: Stable TanStack Query key factories for providers, models, and profiles.
// ABOUTME: Components import factories instead of constructing array keys inline.
export const providerKeys = {
	all: ["providers"] as const,
	list: () => [...providerKeys.all, "list"] as const,
};

export const modelKeys = {
	all: ["models"] as const,
	allEnabled: () => [...modelKeys.all, "enabled"] as const,
	byProvider: (providerInstanceId: string) => [...modelKeys.all, "provider", providerInstanceId] as const,
};

export const profileKeys = {
	all: ["translation-profiles"] as const,
	list: () => [...profileKeys.all, "list"] as const,
	detail: (id: string) => [...profileKeys.all, "detail", id] as const,
};
