import type { AppState, RefreshSummary } from "../models";

export type AppResumeDetails = Readonly<{
  queryParameters?: Readonly<Record<string, unknown>> | null;
  notificationInfo?: Readonly<{
    request?: Readonly<{
      content?: Readonly<{
        userInfo?: Readonly<Record<string, unknown>> | null;
      }> | null;
    }> | null;
  }> | null;
}>;

function shipmentValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function resumeShipmentId(details: AppResumeDetails): string {
  return shipmentValue(details.queryParameters?.shipment) ||
    shipmentValue(
      details.notificationInfo?.request?.content?.userInfo?.shipment,
    );
}

export async function reloadAndRefreshOnResume(
  details: AppResumeDetails,
  dependencies: Readonly<{
    load: () => AppState;
    applyPersisted: (state: AppState, shipmentId: string) => void;
    refresh: () => Promise<RefreshSummary>;
    applyRefreshed: (state: AppState) => void;
  }>,
): Promise<void> {
  const persisted = dependencies.load();
  dependencies.applyPersisted(persisted, resumeShipmentId(details));
  try {
    const summary = await dependencies.refresh();
    dependencies.applyRefreshed(summary.state);
  } catch {
    /* the freshly reloaded persisted state remains visible */
  }
}
