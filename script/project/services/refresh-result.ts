export type RefreshResultCounts = Readonly<{
  attempted: number;
  succeeded: number;
  failed: number;
}>;

export function refreshIntentMessage(summary: RefreshResultCounts): string {
  if (summary.attempted <= 0) return "暂无需要更新的快递。";
  if (summary.succeeded <= 0) return "快递更新失败，请稍后重试。";
  if (summary.failed > 0) {
    return `已更新 ${summary.succeeded} 票，${summary.failed} 票更新失败。`;
  }
  return `已更新 ${summary.succeeded} 票快递。`;
}
