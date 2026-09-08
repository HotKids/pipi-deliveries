import type { Shipment } from "../models";
import { containsTimelineStartTrack } from "./status";

export type ManualDetailSourceOutcome = Readonly<{
  shipment: Shipment | null;
  error: unknown | null;
}>;

export type ManualDetailSourceContest = Readonly<{
  moto: ManualDetailSourceOutcome;
  kuaidi100: ManualDetailSourceOutcome;
  kdniao: ManualDetailSourceOutcome;
  primarySuccessCount: number;
  primaryReachedTimelineStart: boolean;
  kdniaoAttempted: boolean;
}>;

async function settle(
  query: () => Promise<Shipment | null>,
): Promise<ManualDetailSourceOutcome> {
  try {
    return { shipment: await query(), error: null };
  } catch (error) {
    return { shipment: null, error };
  }
}

/**
 * Moto and K100 are peers and start before either result is awaited. KDNiao is
 * a final fallback only when neither primary source reached the order or
 * pickup stage.
 */
export async function runManualDetailSourceContest(input: Readonly<{
  queryMoto: () => Promise<Shipment | null>;
  queryKuaidi100: () => Promise<Shipment | null>;
  queryKdniao?: () => Promise<Shipment | null>;
  canQueryKdniao?: () => boolean;
  hasAccumulatedTimelineStart?: (
    shipments: readonly Shipment[],
  ) => boolean;
}>): Promise<ManualDetailSourceContest> {
  const motoTask = settle(input.queryMoto);
  const kuaidi100Task = settle(input.queryKuaidi100);
  const [moto, kuaidi100] = await Promise.all([motoTask, kuaidi100Task]);
  const primarySuccessCount = Number(Boolean(moto.shipment)) +
    Number(Boolean(kuaidi100.shipment));
  const primaryShipments = [moto.shipment, kuaidi100.shipment]
    .filter((shipment): shipment is Shipment => Boolean(shipment));
  const primaryReachedTimelineStart = input.hasAccumulatedTimelineStart
    ? input.hasAccumulatedTimelineStart(primaryShipments)
    : primaryShipments.some((shipment) =>
        containsTimelineStartTrack(shipment.timeline.tracks)
      );
  const kdniaoAttempted = Boolean(
    !primaryReachedTimelineStart &&
      input.queryKdniao &&
      (input.canQueryKdniao?.() ?? true),
  );
  const kdniao = kdniaoAttempted
    ? await settle(input.queryKdniao!)
    : { shipment: null, error: null };
  return {
    moto,
    kuaidi100,
    kdniao,
    primarySuccessCount,
    primaryReachedTimelineStart,
    kdniaoAttempted,
  };
}
