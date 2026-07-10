// ABOUTME: Shared provider-list state for nested Models routes.
// ABOUTME: Keeps route selection in the URL while sharing loaded provider DTOs.
import { createContext, useContext } from "react";
import type { ProviderInstanceDto } from "../../storage/types";

export type ModelsContextValue = {
	providers: ProviderInstanceDto[];
	providersLoading: boolean;
	providersError: string | null;
	refreshProviders: () => Promise<void>;
	upsertProvider: (provider: ProviderInstanceDto) => void;
};

export const ModelsContext = createContext<ModelsContextValue | null>(null);

/** Access models layout context; throws when used outside ModelsLayout. */
export function useModelsContext(): ModelsContextValue {
	const value = useContext(ModelsContext);
	if (!value) {
		throw new Error("useModelsContext must be used within ModelsLayout");
	}
	return value;
}
