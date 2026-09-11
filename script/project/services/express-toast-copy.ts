/**
 * Express toast copy shared by the three clients (AGENTS §11, 2026-09-03: 快递相关 toast 三端统一；
 * 2026-09-05 扩成整张表：每个场景一行，页面只能按 key 取，不许写自由文案).
 * The same strings live in Pipi `express/ExpressToastCopy.java` (+ Dart mirror
 * `lib/express/express_toast_copy.dart`) and Lite `feature/express/ExpressToastCopy.java`; change
 * them all together and update the table in docs/EXPRESS_THREE_CLIENT_PARITY_20260901.md.
 * 只有用户手势才弹：后台轮询、推送落库永远静默。
 */
export const EXPRESS_TOAST_COPY = Object.freeze({
  /** 手动查件已提交，短 toast 一次。 */
  manualQuerying: "正在查询，请稍候",
  /** 手动查件拿到带时间的轨迹。 */
  manualQuerySucceeded: "轨迹加载成功",
  /** 手动查件各级都跑完但没有可用轨迹。 */
  manualQueryNoTrack: "暂未获取到可用轨迹",
  /** 手动查件失败（非校验、非超时）；上游文案不外露。 */
  manualQueryFailed: "查询失败，请稍后重试",
  /** 手动查件超时。 */
  manualQueryTimeout: "请求超时，请稍后重试",
  /** A visible manual query still needs a valid parcel phone suffix after available candidates. */
  manualPhoneTailRequired: "该运单需要手机号后四位，请重新添加并填写",
  /** A manual query was submitted for a waybill the list already tracks; no provider runs. */
  alreadyInList: "该快递已在列表中",
  /** 列表下拉：全部成功。 */
  refreshDone: "刷新完成",
  /** 列表下拉：没有需要刷新的行。 */
  refreshUpToDate: "当前已是最新",
  /** 列表下拉：部分成功。 */
  refreshPartial: "刷新完成，部分快递暂未更新",
  /** The account list committed successfully; only per-parcel supplementation failed. */
  listUpdated: "列表已更新",
  /** 列表下拉：全部失败或整轮抛错。 */
  refreshFailed: "刷新失败，请稍后重试",
  /** 详情下拉：拉到了新轨迹。 */
  detailRefreshed: "轨迹加载成功",
  /** 详情下拉：跑完了但没有更新，已有可用轨迹。 */
  detailUpToDate: "当前轨迹已是最新",
  /** 详情下拉：跑完了仍没有可用轨迹。 */
  detailNoTrack: "暂未获取到可用轨迹",
  /** 详情下拉抛错且页面上没有任何轨迹可看；有缓存可看时静默。 */
  detailRefreshFailed: "轨迹更新失败，请稍后重试",
  /** JD union page answered with risk control (HTTP 403 / "刷新几遍还不行"); the order rests 60 min. */
  jdRiskControl: "操作过于频繁，请稍候再试",
  /** 物流 H5 页（菜鸟半屏、K100 页）打不开。 */
  h5Unavailable: "暂时无法加载详情",
  /** 删除成功。 */
  deleted: "该快递已删除",
  /** 删除失败。 */
  deleteFailed: "删除失败，请稍后重试",
  /** 右滑签收成功（当前只有 iOS 列表行有这个手势）。 */
  signed: "已标记为签收",
  /** 右滑签收失败。 */
  signFailed: "标记失败，请稍后重试",
  /** 复制运单号成功。 */
  waybillCopied: "运单号已复制",
  /** 复制运单号失败（只有 iOS 宿主会失败，允许的差异）。 */
  copyFailed: "复制失败，请稍后重试",
  /** 官方电话打不开拨号界面。 */
  dialUnavailable: "无法打开拨号界面",
  /** 账号类（2026-09-05 补）：验证码已发出。 */
  codeSent: "验证码已发送",
  /** 账号类：验证码发送失败的兜底文案；上游给了原因就显示原因。 */
  codeSendFailed: "验证码发送失败，请稍后重试",
  /** 账号类：绑定成功。 */
  phoneBound: "手机号已绑定",
  /** 账号类：绑定失败的兜底文案；上游给了原因就显示原因。 */
  bindFailed: "绑定失败，请稍后重试",
  /** 账号类：解绑成功。 */
  phoneUnbound: "手机号已解绑",
  /** 账号类：解绑失败。 */
  unbindFailed: "解绑失败，请稍后重试",
  /** 存储类：本地状态每个副本都无法迁移时的提示，不当成空列表（2026-09-06）。 */
  stateLoadFailed: "本地快递数据读取失败",
});

/** A refresh reports a unified toast by key; pages render it through the table, never free text. */
export type ExpressToastKey = keyof typeof EXPRESS_TOAST_COPY;
