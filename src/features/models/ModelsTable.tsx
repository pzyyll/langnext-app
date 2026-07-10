// ABOUTME: Provider model table with immediate persisted enabled-state controls.
// ABOUTME: Displays manual, remote, and built-in model DTOs without fabricating data.
import { checkboxClassName } from "../../components/ui";
import type { ProviderModelDto } from "../../storage/types";

export type ModelsTableProps = {
	models: ProviderModelDto[];
	pendingModelIds: ReadonlySet<string>;
	onEnabledChange: (modelId: string, enabled: boolean) => void;
};

function resolveDisplayName(model: ProviderModelDto): string {
	return model.displayNameOverride ?? model.remoteDisplayName ?? "-";
}

export function ModelsTable({ models, pendingModelIds, onEnabledChange }: ModelsTableProps) {
	if (models.length === 0) {
		return <p className="text-sm text-muted">No models for this channel yet.</p>;
	}

	return (
		<div className="overflow-x-auto">
			<table className="w-full min-w-[28rem] text-left">
				<thead>
					<tr className="border-b border-line text-[10px] tracking-wider text-muted uppercase">
						<th className="pb-2 font-semibold">Model</th>
						<th className="pb-2 text-center font-semibold">Display Name</th>
						<th className="pb-2 text-right font-semibold">Enabled</th>
					</tr>
				</thead>
				<tbody className="divide-y divide-line/30">
					{models.map((model) => {
						const pending = pendingModelIds.has(model.id);
						return (
							<tr key={model.id}>
								<td className="py-4">
									<label className="flex items-center gap-3">
										<input
											type="checkbox"
											className={checkboxClassName}
											checked={model.enabled}
											disabled={pending}
											aria-label={`Enable ${model.modelKey}`}
											onChange={(event) => {
												onEnabledChange(model.id, event.currentTarget.checked);
											}}
										/>
										<span className="font-mono text-sm font-bold text-ink">{model.modelKey}</span>
									</label>
								</td>
								<td className="py-4 text-center text-sm text-muted">{resolveDisplayName(model)}</td>
								<td className="py-4 text-right text-sm text-muted">{model.enabled ? "Yes" : "No"}</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}
