export function transientToast(
  message: string,
  setMessage: (message: string) => void,
) {
  return {
    isPresented: Boolean(message),
    onChanged: (isPresented: boolean) => {
      if (!isPresented) setMessage("");
    },
    message,
    duration: 2,
    position: "bottom" as const,
  };
}

export function manualQueryToast(
  querying: boolean,
  message: string,
  setMessage: (message: string) => void,
) {
  return {
    isPresented: querying || Boolean(message),
    onChanged: (isPresented: boolean) => {
      if (!isPresented && !querying) setMessage("");
    },
    message: querying ? "正在查询，请稍候" : message,
    duration: querying ? 60 : 2,
    position: "bottom" as const,
  };
}

export function refreshSummaryToast(summary: Readonly<{
  attempted: number;
  succeeded: number;
  failed: number;
}>): string {
  if (summary.failed > 0 && summary.succeeded > 0) {
    return "刷新完成，部分快递暂未更新";
  }
  if (summary.failed > 0) return "刷新失败，请稍后重试";
  if (summary.attempted === 0) return "当前已是最新";
  return "刷新完成";
}

export function manualDetailRefreshToast(
  refreshed: boolean,
  hasUsableDetail: boolean,
): string {
  if (refreshed && hasUsableDetail) return "轨迹加载成功";
  return hasUsableDetail ? "" : "暂未获取到可用轨迹";
}
