import { ACCOUNT_FOLLOWUP_RESERVE_MS } from "./account-sync-policy";

export const FULL_REFRESH_FINALIZATION_RESERVE_MS = 3_000;

export type FullRefreshHostPolicy = Readonly<{
  accountOrderProjection: boolean;
  webViewEnrichment: boolean;
  accountFollowupReserveMs: number;
  accountFollowups: boolean;
  manualAndPending: boolean;
}>;

export function fullRefreshHostPolicy(options: Readonly<{
  accountOrderProjection: boolean;
  backgroundHostSafe: boolean;
}>): FullRefreshHostPolicy {
  if (options.backgroundHostSafe) {
    return {
      accountOrderProjection: false,
      webViewEnrichment: false,
      accountFollowupReserveMs: 0,
      accountFollowups: true,
      manualAndPending: true,
    };
  }
  return {
    accountOrderProjection: options.accountOrderProjection,
    webViewEnrichment: true,
    accountFollowupReserveMs: ACCOUNT_FOLLOWUP_RESERVE_MS,
    accountFollowups: true,
    manualAndPending: true,
  };
}
