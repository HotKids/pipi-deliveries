import { loadCarrierAuthorityCache } from "./carrier-authority";

export function backgroundHostBootstrap(): void {
  loadCarrierAuthorityCache();
}

export function backgroundRefreshOptions(budgetMs = 120_000) {
  return { budgetMs, accountOrderProjection: true, backgroundHostSafe: true } as const;
}
