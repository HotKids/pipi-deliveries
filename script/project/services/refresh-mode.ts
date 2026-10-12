import { ACCOUNT_FOLLOWUP_RESERVE_MS } from "./account-sync-policy";

export const FULL_REFRESH_FINALIZATION_RESERVE_MS = 3_000;

export type FullRefreshHostPolicy = Readonly<{
  accountOrderProjection: boolean;
  accountFollowupReserveMs: number;
}>;

export function fullRefreshHostPolicy(options: Readonly<{
  accountOrderProjection: boolean;
  backgroundHostSafe: boolean;
}>): FullRefreshHostPolicy {
  if (options.backgroundHostSafe) {
    return {
      accountOrderProjection: false,
      accountFollowupReserveMs: 0,
    };
  }
  return {
    accountOrderProjection: options.accountOrderProjection,
    accountFollowupReserveMs: ACCOUNT_FOLLOWUP_RESERVE_MS,
  };
}
