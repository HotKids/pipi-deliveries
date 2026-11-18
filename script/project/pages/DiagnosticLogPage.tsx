import {
  Button,
  HStack,
  Image,
  List,
  Section,
  Spacer,
  Text,
  VStack,
  useState,
} from "scripting";
import {
  clearDiagnostics,
  diagnosticText,
  diagnosticsEnabled,
  readDiagnostics,
  setDiagnosticsEnabled,
  writeRuntimeCapabilities,
  type DiagnosticDetails,
  type DiagnosticEntry,
} from "../services/logger";
import { copyText } from "../services/clipboard";
import { transientToast } from "../services/ui-feedback";

const EVENT_TITLES: Record<string, string> = {
  "app.state.applied": "页面状态已更新",
  "binding.flow.opened": "开始绑定手机号",
  "platform.pdd.import.unavailable": "拼多多快递导入未完成",
  "platform.sync.unavailable": "平台快递同步未完成",
  "platform.jingdong.sync.failed": "京东同步失败",
  "platform.jingdong.session.save_failed": "京东会话未能保存",
  "binding.handler.entered": "已进入绑定流程",
  "binding.code.started": "正在发送验证码",
  "binding.code.succeeded": "验证码发送成功",
  "binding.code.failed": "验证码发送失败",
  "binding.verify.started": "正在验证绑定",
  "binding.verify.succeeded": "绑定验证成功",
  "binding.verify.failed": "绑定验证失败",
  "binding.persisted": "绑定记录已保存",
  "binding.persist.failed": "绑定记录保存失败",
  "binding.refresh.succeeded": "绑定后同步完成",
  "binding.refresh.failed": "绑定后同步失败",
  "manager.rendered": "手机号页面已刷新",
  "storage.state.saved": "本地状态已保存",
  "storage.state.recovered": "本地状态已恢复",
  "storage.state.rejected": "本地状态校验失败",
  "storage.state.failed": "本地状态保存失败",
  "detail.refresh.started": "详情刷新开始",
  "detail.refresh.stage_started": "详情刷新阶段开始",
  "detail.refresh.stage_succeeded": "详情刷新阶段完成",
  "detail.refresh.stage_failed": "详情刷新阶段失败",
  "detail.refresh.stage_skipped": "详情刷新阶段跳过",
  "detail.refresh.skipped": "详情无需刷新",
  "detail.refresh.committed": "详情已更新",
  "detail.refresh.failed": "详情刷新失败",
  "detail.refresh.ui_failed": "详情页刷新失败",
  "detail.refresh.fallback_failed": "详情兜底失败",
  "detail.refresh.primary_contest.completed": "详情主数据源查询完成",
  "detail.refresh.alignment": "状态与头条对不上，强制刷新",
  "detail.route_publish_failed": "详情路由保存失败",
  "account.identity.generated": "已创建本机身份",
  "account.sync.parsed": "关联快递已解析",
  "account.sync.failed": "账号快递同步失败",
  "account.owner.superseded": "同一运单换了新包裹，旧件让位",
  "order.projection.started": "正在提取运单号",
  "order.projection.extracted": "已提取运单号",
  "order.projection.committed": "运单号已保存",
  "order.projection.succeeded": "运单号提取成功",
  "order.projection.empty": "页面尚未返回运单号",
  "order.projection.failed": "运单号提取失败",
  "order.projection.skipped": "本次无需提取运单号",
  "manual.query.completed": "手动查询完成",
  "manual.source.started": "数据源查询开始",
  "manual.source.succeeded": "数据源查询成功",
  "manual.source.skipped": "数据源没有有效轨迹",
  "manual.source.failed": "数据源查询失败",
  "refresh.started": "快递同步开始",
  "refresh.stage.started": "快递刷新阶段开始",
  "refresh.stage.succeeded": "快递刷新阶段完成",
  "refresh.stage.failed": "快递刷新阶段失败",
  "refresh.stage.skipped": "快递刷新阶段跳过",
  "refresh.commit.skipped": "快递刷新结果未写入",
  "refresh.route_publish_failed": "快递路由保存失败",
  "refresh.succeeded": "快递同步完成",
  "refresh.failed": "快递同步失败",
  // 2026-11-12 诊断日志统一（与 Pipi 诊断日志同一套书面标题）：凡是会写入的事件都有中文标题，页面不再露出原始事件键。
  "app.startup.failed": "应用启动失败",
  "app.session.failed": "应用会话失败",
  "app.resume.failed": "回到前台恢复失败",
  "app.shortcut.resume.failed": "快递识别结果读取失败",
  "app.scene.changed": "前后台状态变化",
  "activity.parcel.reconcile.failed": "取件实时活动更新失败",
  "activity.parcel.restore.failed": "快递实时活动恢复失败",
  "activity.parcel.expiry.failed": "寄件码到期状态保存失败",
  "runtime.capabilities": "运行环境能力缺失",
  "account.sync.started": "账号快递同步开始",
  "account.list.record": "账号列表记录",
  "account.external.cached": "来源 App 入口已缓存",
  "account.enhanced.completed": "增强同步完成",
  "account.enhanced.failed": "增强同步失败",
  "account.enhanced.skipped": "增强同步跳过",
  "account.enhanced.unsubscribe_failed": "增强退订失败",
  "account.enhanced.unsubscribe_skipped": "增强退订跳过",
  "carrier.authority.loaded": "承运商表已加载",
  "carrier.authority.refreshed": "承运商表已更新",
  "carrier.authority.skipped": "承运商表无需更新",
  "carrier.authority.failed": "承运商表更新失败",
  "carrier.recognition.completed": "承运商识别完成",
  "detail.refresh.carrier_repaired": "详情刷新已修正承运商",
  "detail.timeline.selected": "详情显示轨迹",
  "detail.timeline.candidate": "详情候选轨迹",
  "detail.selection.record_failed": "详情选包记录失败",
  "detail.external.routes": "外跳入口已就绪",
  "detail.external.request": "外跳入口请求开始",
  "detail.external.request_failed": "外跳入口请求失败",
  "detail.external.cache_failed": "外跳入口缓存失败",
  "detail.external.open": "打开外部 App",
  "detail.image.failed": "商品图加载失败",
  "detail.image.lease_release_failed": "商品图释放失败",
  "detail.image.wait_cleanup_failed": "商品图等待清理失败",
  "detail.note.prompt_failed": "备注输入失败",
  "detail.note.save_failed": "备注保存失败",
  "detail.product_name.prompt_failed": "商品名输入失败",
  "detail.product_name.save_failed": "商品名保存失败",
  "settings.platform_count.unavailable": "数据源状态不可用",
  "product.image.completed": "商品图处理完成",
  "product.image.cache_cleanup_failed": "商品图缓存清理失败",
  "gateway.activation.resolved": "Access Key 激活完成",
  "gateway.activation.failed": "Access Key 激活失败",
  "gateway.credential.cleanup": "旧凭据清理失败",
  "gateway.request.wait_ended": "Worker 请求等待结束",
  "gateway.request.late_settled": "Worker 请求超时后返回",
  "manual.meizu.response": "v6_query 回包",
  "order.projection.rejected": "运单号提取结果被拒绝",
  "order.projection.reference_failed": "订单关联读取失败",
  "ownership.split.applied": "已拆开合并的运单",
  "ownership.split.skipped": "运单拆分跳过",
  "ownership.split.completed": "运单拆分完成",
  "notification.replay.started": "通知补发开始",
  "notification.replay.loaded": "通知补发已读取",
  "notification.replay.completed": "通知补发完成",
  "notification.replay.skipped": "通知补发跳过",
  "notification.replay.deferred": "通知补发延后",
  "notification.fengchao.reminder.failed": "丰巢取件提醒处理失败",
  "notification.replay.failed": "通知补发失败",
  "notification.schedule.failed": "通知发送失败",
  "refresh.skipped": "快递同步跳过",
  "refresh.wait.started": "等待其他刷新结束",
  "refresh.wait.completed": "其他刷新已结束",
  "refresh.preparation.started": "准备阶段开始",
  "refresh.preparation.completed": "准备阶段完成",
  "refresh.account.completed": "账号阶段完成",
  "refresh.enrichment.started": "逐票补充开始",
  "refresh.enrichment.completed": "逐票补充完成",
  "refresh.finalization.started": "收尾阶段开始",
  "refresh.finalization.completed": "收尾阶段完成",
  "refresh.finalization.skipped": "收尾阶段跳过",
  "refresh.ownership.invalidated": "刷新所有权失效",
  "refresh.presentation.failed": "刷新结果显示失败",
  "storage.transaction.retry": "本地事务重试",
  "storage.transaction.uncertain": "本地事务结果未知",
  "shipment.complete.succeeded": "已标记为签收",
  "shipment.complete.failed": "标记签收失败",
  "shipment.delete.succeeded": "快递已删除",
  "shipment.delete.failed": "快递删除失败",
  "widget.run.started": "小组件开始运行",
  "widget.run.presenting": "小组件开始显示",
  "widget.refresh.completed": "小组件刷新完成",
  "widget.refresh.skipped": "小组件刷新跳过",
  "widget.refresh.failed": "小组件刷新失败",
};

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

function timeText(value: string): string {
  const date = new Date(value);
  return `${twoDigits(date.getMonth() + 1)}-${twoDigits(date.getDate())} ${twoDigits(
    date.getHours(),
  )}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}`;
}

function failureText(item: DiagnosticEntry): string | null {
  if (item.details.httpStatus === 401 && item.details.failureCode === "unauthorized") {
    return "Access Key 不可用";
  }
  return item.details.failureCode ? `代码 ${item.details.failureCode}` : null;
}

function stageText(value: string): string {
  return ({
    // 统一用词（2026-09-05）：这一级就叫它的 level 词，不再翻成品牌词；旧日志里的名字也映过去。
    // 2026-11-12 与 Pipi 阶段表同一格式：账号列表写「vN_list 同步」，逐票查询写「<level> 查询」。
    v6_picker: "v6_query 查询",
    meizu_picker: "v6_query 查询",
    picker: "v6_query 查询",
    picker_query: "v6_query 查询",
    pending_picker: "v6_query 查询",
    v6_query: "v6_query 查询",
    v6_refresh: "v6_refresh 查询",
    account_detail: "v5_query 查询",
    v5_query: "v5_query 查询",
    account_list: "v5_list 同步",
    v5_list: "v5_list 同步",
    v3_list: "v3_list 同步",
    v6_list: "v6_list 同步",
    cainiao: "cainiao",
    jingdong: "jingdong",
    shunfeng: "sfexpress",
    sfexpress: "sfexpress",
    douyin: "douyin",
    cainiao_h5: "cn_h5 查询",
    cn_h5: "cn_h5 查询",
    jingdong_h5: "jd_h5 查询",
    jd_sync_queue: "等待网页同步",
    jd_sync_session: "确认京东会话",
    jd_sync_viewport: "打开京东网页",
    jd_sync_orders: "读取京东订单",
    jd_sync_document: "等待京东网页提交导航",
    jd_sync_load_failed: "京东网页导航失败",
    jd_sync_script: "执行京东网页脚本",
    jd_sync_unexpected_page: "京东网页停在其他页面",
    jd_sync_order_navigation: "等待京东订单列表",
    jd_sync_order_entry: "查找京东订单入口",
    jd_sync_order_cards: "解析京东订单卡片",
    jd_sync_detail: "读取京东物流详情",
    jd_sync_save: "保存京东同步结果",
    jd_h5: "jd_h5 查询",
    kdniao_fallback: "kdniao 查询",
    pending_kdniao: "kdniao 查询",
    kdniao: "kdniao 查询",
    kuaidi100: "k100_h5 查询",
    kuaidi100_query: "k100_h5 查询",
    k100_h5: "k100_h5 查询",
    jt_h5: "jt_h5 查询",
    v2_query: "v2_query 查询",
    local: "v4_query 查询",
    moto_query: "v4_query 查询",
    pending_moto: "v4_query 查询",
    v4_query: "v4_query 查询",
    route: "v6_query 查询",
    fallback: "kdniao 查询",
    classify: "承运商识别",
    carrier_detect: "承运商识别",
    k100_autoCom: "承运商识别",
    auto_com_num: "承运商识别",
    worker_classify: "承运商识别",
    manual_query: "手动查询",
    manual_fallback: "手动查询兜底",
    manual_refresh: "在线补查",
    detail_refresh: "详情刷新",
    status_alignment: "状态对齐强刷",
    activation_identity: "Access Key 激活",
    credential_storage: "凭据存储",
    cache: "本地缓存",
    metadata: "增强元数据",
    preparation: "准备阶段",
    prune: "过期清理",
    validation: "数据校验",
    lease_wait: "等待刷新租约",
    notification_read: "通知读取",
    notifications: "通知发布",
    widget_timeline: "小组件时间线",
    widget_present: "小组件显示",
    manual_sources: "手动查件数据源",
    manual_source: "手动查件",
    pending_query: "待查件查询",
    none: "无",
    route_publish: "路由保存",
    primary_contest: "主数据源查询",
    web_timeline: "k100_h5 查询",
    jd: "京东 App",
    taobao: "淘宝 App",
    alipay: "支付宝 App",
    sf: "顺丰 App",
    webview: "网页提取",
    webview_commit: "网页结果写入",
    detail_webview: "详情页运单提取",
    detail_webview_commit: "详情页运单写入",
    full_refresh: "完整同步",
    previous_detail_refresh: "等待上一轮详情刷新",
    forced_projection_after_full_refresh: "同步后运单提取",
    installation_identity: "本机身份",
    keychain: "本机凭据",
    state: "本地状态",
    ui_handler: "页面操作",
  } as Record<string, string>)[value] || value;
}

function providerText(value: string): string {
  return ({
    v6_picker: "v6_query",
    meizu_picker: "v6_query",
    cainiao: "cainiao",
    jingdong: "jingdong",
    shunfeng: "sfexpress",
    sfexpress: "sfexpress",
    douyin: "douyin",
    // 统一用词（2026-09-05）：包名就写 level 词；旧日志里的名字映过去。
    cainiao_h5: "cn_h5",
    jingdong_h5: "jd_h5",
    account: "v5_query",
    web: "cn_h5",
    local: "v4_query",
    moto: "v4_query",
    route: "v6_query",
    meizu: "v6_query",
    fallback: "kdniao",
    kdniao: "kdniao",
    kuaidi100: "k100_h5",
    kuaidi100_h5: "k100_h5",
    interface5: "v5_query",
    interface6: "v6_list",
    none: "无",
  } as Record<string, string>)[value] || value;
}

function timelineProviderText(item: DiagnosticEntry): string | null {
  const provider = item.details.timelineProvider;
  if (!provider) return null;
  const value = providerText(provider);
  if (item.event === "manual.query.completed") return item.details.selectionScope === "query_response"
    ? `回包数据源 ${value}` : `选中数据源 ${value}`;
  if (
    item.event.startsWith("manual.source.") ||
    item.event.startsWith("detail.refresh.stage_") ||
    item.event.startsWith("refresh.stage.")
  ) return `查询数据源 ${value}`;
  if (
    item.event === "detail.refresh.started" ||
    item.event === "detail.refresh.committed" ||
    item.event === "detail.refresh.skipped"
  ) return `刷新前数据源 ${value}`;
  return `数据源 ${value}`;
}

function executionBoundaryText(value: string): string {
  return value === "host_budget" ? "宿主总预算" : "分阶段预算";
}

/**
 * The line's title. `detail.refresh.alignment` carries three kinds of line (the forced refresh, a row the signed freeze
 * stops, and the forced refresh failing), and `detail.refresh.skipped` also closes a pull that joined a running refresh,
 * so their titles follow the line rather than the event alone.
 */
function eventTitle(item: DiagnosticEntry): string {
  if (item.event === "detail.refresh.alignment") {
    if (item.details.skipReason === "signed_frozen") return "状态与头条对不上，已签收冻结，不强刷";
    if (item.details.result === "failed") return "状态对齐强刷失败";
  }
  // A pull that met this row's status-alignment refresh waited for it and shows its outcome (user 2026-10-02).
  if (item.event === "detail.refresh.skipped" && item.details.skipReason === "coalesced_detail_refresh") {
    return "详情下拉等待正在执行的刷新";
  }
  return EVENT_TITLES[item.event] || item.event;
}

function reasonText(value: string): string {
  return ({
    no_tracks: "没有有效时间节点",
    status_unknown: "当前状态未知",
    latest_unknown: "最新节点状态无法识别",
    status_mismatch: "最新节点与当前状态不一致",
    missing_pickup: "缺少揽收证据",
    time_mismatch: "详情与列表最新时间不一致",
    sf_active: "顺丰件尚未进入终态",
    missing_source_time: "缺少来源时间基准",
    cache_read: "读取本地缓存",
    list_pull: "列表下拉",
    detail_open: "打开详情",
    detail_pull: "详情下拉",
    status_alignment: "状态对齐强刷",
    status_ahead: "状态比头条新",
    headline_ahead: "头条比状态新",
    detail_behind: "详情与列表不一致",
    signed_frozen: "已签收冻结",
    aligned_after_query: "按件查询后已对齐",
    background: "后台刷新",
    foreground: "前台同步",
    account_list_only: "账号列表同步",
    available: "缓存有轨迹",
    empty: "缓存无轨迹",
    account_record_missing: "缺少账号详情记录",
    background_host_webview_disabled: "后台宿主不允许网页提取",
    coalesced_detail_refresh: "详情刷新已在执行",
    refreshed: "已更新",
    unchanged: "没有变化",
    deadline_exhausted: "刷新预算已用尽",
    home_projection: "首页提取运单号",
    not_foreground: "不在前台",
    confirmed_empty: "已确认空页",
    evaluation_exhausted: "已达到页面提取次数上限",
    load_failed: "页面加载失败",
    no_result: "没有可写入的新结果",
    no_timed_tracks: "没有提取到有效时间轨迹",
    not_due: "尚未到刷新时间",
    not_eligible: "当前快递不满足提取条件",
    route_missing: "没有菜鸟详情路由",
    route_pointer_missing: "快递记录没有菜鸟路由标记",
    route_unavailable: "菜鸟详情路由缺失、失效或不可读",
    route_untrusted: "菜鸟详情路由不可信",
    state_changed: "状态已被其他刷新更新",
    timed_tracks: "已提取有效轨迹",
    waybill_missing: "缺少运单号",
    // 2026-11-12 诊断日志统一：结果与原因也用书面词（与 Pipi 结果表同词），不再露出原始键。
    succeeded: "成功",
    success: "成功",
    failed: "失败",
    timeout: "超时",
    skipped: "已跳过",
    started: "已开始",
    completed: "已完成",
    pending: "等待中",
    pending_retry: "等待重试",
    partial: "部分结果",
    complete: "完整结果",
    committed: "已写入",
    cancelled: "已取消",
    busy: "正在处理",
    foreign_package: "属于其他包裹",
    stored: "已保存",
    omitted: "本轮未返回",
    not_retained: "未保留",
    binding_unmatched: "没有匹配的绑定",
    cached: "已缓存",
    cache_loaded: "已读取缓存",
    cache_unavailable: "缓存不可用",
    applied: "已应用",
    attempted: "已尝试",
    settled: "已结束",
    split: "已拆分",
    installed: "已安装",
    install_rejected: "安装被拒绝",
    interrupted: "已中断",
    cooldown: "冷却中",
    inactive: "不在活动状态",
    lease_held: "刷新租约被占用",
    reserved_elsewhere: "已被其他刷新占用",
    ownership_lost: "失去刷新所有权",
    nothing_due: "没有到期任务",
    not_app_host: "不在主应用中",
    carrier_pending: "承运商尚未识别",
    already_projected: "已有运单号",
    no_eligible_orders: "没有可提取的订单",
    native_pending: "等待系统处理",
    late_ignored: "迟到结果已忽略",
    invalid_url: "地址无效",
    invalid_payload: "数据无效",
    identity_unavailable: "本机身份不可用",
    generation_conflict: "版本冲突",
    ambiguous: "无法确定",
    query_failed: "查询失败",
    save_failed: "保存失败",
    cleanup_failed: "清理失败",
    recognition_reset_failed: "识别记录重置失败",
    migration_failed: "迁移失败",
    durable_write_failed: "持久化写入失败",
    durable_heal_failed: "持久化修复失败",
    durable_and_mirrors: "已写入主副本与镜像",
    durable_only: "仅写入主副本",
    probe_failed: "检测失败",
    awaiting_status_alignment: "等待状态对齐",
    active_notification_replay: "通知补发正在执行",
    active_cross_runtime_refresh: "其他进程正在刷新",
    acknowledgement_unknown: "确认结果未知",
    recent_state: "数据仍是最新",
    timed_out: "已超时",
    budget_exhausted: "预算已用尽",
    opened: "已打开",
    no_handler: "没有可打开的 App",
    open_failed: "打开失败",
    active: "前台",
    automatic: "自动",
    identity_projection: "运单号提取",
    product_image: "商品图",
    source_policy: "按来源规则",
    foreground_sync: "前台同步",
    deadline: "截止时间",
    removed: "已从列表移除",
    small: "小尺寸",
    medium: "中尺寸",
    unsupported: "不支持的尺寸",
    dom: "页面 DOM",
    dom_modal: "弹层 DOM",
    data_array: "页面数据",
    script: "页面脚本",
    vue: "Vue 数据",
    diagnostic: "诊断探针",
    invalid_time: "时间无效",
    none: "无",
  } as Record<string, string>)[value] || value;
}

/** errorCategory 与 Pipi 诊断日志的错误分类表同词（2026-11-12）；iOS 独有的分类另外补上。 */
function errorText(value: string): string {
  return ({
    cancelled: "操作取消",
    timeout: "请求超时",
    authorization: "认证或权限失败",
    rate_limited: "请求频率受限",
    service: "上游服务失败",
    upstream: "上游服务失败",
    protocol: "返回协议异常",
    validation: "输入或数据校验失败",
    network: "网络连接失败",
    storage: "本地存储失败",
    no_result: "没有有效结果",
    removed: "快递已从列表移除",
    state_changed: "状态已被其他刷新更新",
    unknown: "未知错误",
  } as Record<string, string>)[value] || reasonText(value);
}

/** 旧日志（2026-09-05 统一用词前）的布尔键还要能读出来。 */
function legacyBool(
  details: DiagnosticDetails,
  key: keyof DiagnosticDetails,
  legacyKey: string,
): boolean | null {
  const current = details[key];
  if (typeof current === "boolean") return current;
  const legacy = (details as Record<string, unknown>)[legacyKey];
  return typeof legacy === "boolean" ? legacy : null;
}

function bindingsCount(details: DiagnosticDetails): number | null {
  if (details.v5Bindings != null) return details.v5Bindings;
  const legacy = (details as Record<string, unknown>).interface5Bindings;
  return typeof legacy === "number" ? legacy : null;
}

function detailsText(item: DiagnosticEntry): string {
  const details = item.details;
  const hasSource = Boolean(
    details.requestedSource ||
    details.handlerSource ||
    details.source ||
    details.activeSource ||
    details.baseActiveSource,
  );
  const parts = [
    details.runtimeHost ? `运行宿主 ${details.runtimeHost === "widget" ? "小组件" : "主应用"}` : null,
    details.sqliteOpenAvailable != null ? `SQLite ${details.sqliteOpenAvailable ? "可用" : "不可用"}` : null,
    details.sharedFilesAvailable != null ? `共享文件${details.sharedFilesAvailable ? "可用" : "不可用"}` : null,
    details.hotlineMatchesExpected != null ? `客服电话校验${details.hotlineMatchesExpected ? "通过" : "未通过"}` : null,
    details.carrierRefreshRemainingMs != null ? `承运商表 ${Math.ceil(details.carrierRefreshRemainingMs / 60_000)} 分钟后更新` : null,
    details.waitTimeoutOrigin ? `等待结束原因 ${reasonText(details.waitTimeoutOrigin)}` : null,
    details.waitElapsedMs != null ? `等待 ${details.waitElapsedMs} ms` : null,
    details.deadlineLagMs != null ? `截止延迟 ${details.deadlineLagMs} ms` : null,
    details.clientBuild != null ? `构建 ${details.clientBuild}` : null,
    details.trigger ? `触发 ${reasonText(details.trigger)}` : null,
    hasSource ? "统一通道" : null,
    details.waybillTail ? `运单尾号 ${details.waybillTail}` : null,
    details.sourceProvider
      ? `自动来源 ${details.sourceProvider}`
      : null,
    details.carrierCode ? `承运商 ${details.carrierCode}` : null,
    details.automatic != null
      ? details.automatic ? "自动件" : "手动件"
      : null,
    details.baseRevision != null ? `起始版本 ${details.baseRevision}` : null,
    details.revision != null ? `版本 ${details.revision}` : null,
    details.resultRevision != null ? `结果版本 ${details.resultRevision}` : null,
    bindingsCount(details) != null ? `绑定 ${bindingsCount(details)}` : null,
    details.attempted != null ? `尝试 ${details.attempted}` : null,
    details.succeeded != null ? `成功 ${details.succeeded}` : null,
    details.failed != null ? `失败 ${details.failed}` : null,
    details.candidateCount != null ? `缓存候选 ${details.candidateCount}` : null,
    details.availableCandidateCount != null ? `有轨迹候选 ${details.availableCandidateCount}` : null,
    details.captureComplete != null ? `来源标记${details.captureComplete ? "完整" : "不完整"}` : null,
    details.detailComplete != null ? `详情${details.detailComplete ? "完整" : "不完整"}` : null,
    details.incompleteReason ? `不完整原因 ${reasonText(details.incompleteReason)}` : null,
    details.rawRecords != null ? `原始记录 ${details.rawRecords}` : null,
    details.records != null ? `有效记录 ${details.records}` : null,
    details.rejectedRecords != null ? `拒绝记录 ${details.rejectedRecords}` : null,
    details.orders != null ? `订单 ${details.orders}` : null,
    details.routableOrders != null ? `可提取订单 ${details.routableOrders}` : null,
    details.selected != null
      ? `本轮${details.selected ? "已选中" : "未选中"}`
      : null,
    details.webViewAllowed != null
      ? `网页提取${details.webViewAllowed ? "允许" : "禁用"}`
      : null,
    details.routePointerPresent != null
      ? `路由标记${details.routePointerPresent ? "存在" : "缺失"}`
      : null,
    details.routeKind ? `路由类型 ${stageText(details.routeKind)}` : null,
    details.routePresent != null
      ? `路由${details.routePresent ? "可读取" : "不可读取"}`
      : null,
    details.routeTrusted != null
      ? `路由${details.routeTrusted ? "可信" : "不可信"}`
      : null,
    details.routeCaptured != null
      ? `路由${details.routeCaptured ? "已提取" : "未提取"}`
      : null,
    details.waybillPresent != null
      ? `运单号${details.waybillPresent ? "存在" : "缺失"}`
      : null,
    details.loadSettled != null
      ? `加载${details.loadSettled ? "已结束" : "未结束"}`
      : null,
    details.loadCompleted != null
      ? `页面${details.loadCompleted ? "加载成功" : "未加载成功"}`
      : null,
    details.mainPresent != null ? `页面主体${details.mainPresent ? "存在" : "缺失"}` : null,
    details.parsedScriptCount != null ? `已解析脚本 ${details.parsedScriptCount}` : null,
    details.lastParsedScript ? `末个脚本 ${details.lastParsedScript}` : null,
    details.vuePresent != null ? `Vue ${details.vuePresent ? "已加载" : "未加载"}` : null,
    details.jqueryPresent != null ? `jQuery ${details.jqueryPresent ? "已加载" : "未加载"}` : null,
    details.readyState
      ? `页面状态 ${({ loading: "加载中", interactive: "可交互", complete: "已加载" } as Record<string, string>)[details.readyState] || details.readyState}`
      : null,
    details.phoneChallengeVisible != null ? `手机验证${details.phoneChallengeVisible ? "显示" : "未显示"}` : null,
    details.locationNuMatches != null ? `页面运单${details.locationNuMatches ? "一致" : "不一致"}` : null,
    details.vmNumMatches != null ? `查询运单${details.vmNumMatches ? "一致" : "不一致"}` : null,
    details.lastQueriedNumMatches != null ? `查询${details.lastQueriedNumMatches ? "已发起" : "未发起"}` : null,
    details.vmLoading != null ? `查询${details.vmLoading ? "加载中" : "未在加载"}` : null,
    details.carrierSelected != null ? `承运商${details.carrierSelected ? "已选择" : "未选择"}` : null,
    details.carrierCandidateCount != null ? `承运商候选 ${details.carrierCandidateCount}` : null,
    details.allListsCount != null ? `页面全部行 ${details.allListsCount}` : null,
    details.listsCount != null ? `页面显示行 ${details.listsCount}` : null,
    details.queryErrorType != null ? `页面错误 ${details.queryErrorType ? errorText(details.queryErrorType) : "未报告"}` : null,
    details.rawExtractedCount != null ? `提取行 ${details.rawExtractedCount}` : null,
    details.firstTimePresent != null ? `首行时间${details.firstTimePresent ? "存在" : "缺失"}` : null,
    details.firstFtimePresent != null ? `首行 ftime ${details.firstFtimePresent ? "存在" : "缺失"}` : null,
    details.firstContextPresent != null ? `首行内容${details.firstContextPresent ? "存在" : "缺失"}` : null,
    details.firstRowOutcome ? `首行结果 ${reasonText(details.firstRowOutcome)}` : null,
    details.startupRecovery ? `启动恢复 ${reasonText(details.startupRecovery)}` : null,
    details.phoneVerificationAttempted != null ? `尾号验证${details.phoneVerificationAttempted ? "已尝试" : "未尝试"}` : null,
    details.timedTrackCount != null ? `页面有效轨迹 ${details.timedTrackCount}` : null,
    details.evaluationAttempts != null
      ? `提取尝试 ${details.evaluationAttempts}`
      : null,
    details.evaluationFailures != null
      ? `提取异常 ${details.evaluationFailures}`
      : null,
    details.extractionSource
      ? `提取来源 ${reasonText(details.extractionSource)}`
      : null,
    details.rawTrackCount != null
      ? `原始轨迹 ${details.rawTrackCount}`
      : null,
    details.validTrackCount != null
      ? `有效轨迹 ${details.validTrackCount}`
      : null,
    details.returnedTrackCount != null ? `回包轨迹 ${details.returnedTrackCount}` : null,
    details.displayedTrackCount != null ? `显示轨迹 ${details.displayedTrackCount}` : null,
    details.returnedTrackCount == null && details.displayedTrackCount == null && details.effectiveTrackCount != null
      ? `当前轨迹 ${details.effectiveTrackCount}`
      : null,
    details.detailEffectiveTrackCount != null
      ? `详情有效轨迹 ${details.detailEffectiveTrackCount}`
      : null,
    legacyBool(details, "v4QuerySupported", "motoSupported") != null
      ? `v4_query ${legacyBool(details, "v4QuerySupported", "motoSupported") ? "可查询" : "不可查询"}`
      : null,
    legacyBool(details, "v4QuerySucceeded", "motoSucceeded") != null
      ? `v4_query ${legacyBool(details, "v4QuerySucceeded", "motoSucceeded") ? "成功" : "未成功"}`
      : null,
    legacyBool(details, "k100H5Succeeded", "kuaidi100Succeeded") != null
      ? `k100_h5 ${legacyBool(details, "k100H5Succeeded", "kuaidi100Succeeded") ? "成功" : "未成功"}`
      : null,
    details.primarySuccessCount != null
      ? `主数据源成功 ${details.primarySuccessCount}`
      : null,
    details.kdniaoAttempted != null
      ? (details.kdniaoAttempted ? "已尝试 kdniao" : "未尝试 kdniao")
      : null,
    details.kdniaoSucceeded != null
      ? `kdniao ${details.kdniaoSucceeded ? "成功" : "未成功"}`
      : null,
    details.persisted != null
      ? `结果${details.persisted ? "已写入" : "未写入"}`
      : null,
    timelineProviderText(item),
    details.requestProvider ? `请求接口 ${providerText(details.requestProvider)}` : null,
    details.displayTimelineProvider ? `显示缓存 ${providerText(details.displayTimelineProvider)}` : null,
    details.finalTimelineProvider
      ? `列表数据源 ${providerText(details.finalTimelineProvider)}`
      : null,
    details.detailTimelineProvider
      ? `详情轨迹 ${providerText(details.detailTimelineProvider)}`
      : null,
    details.skipReason ? `跳过原因 ${reasonText(details.skipReason)}` : null,
    details.alignmentReason ? `对不上 ${reasonText(details.alignmentReason)}` : null,
    details.headlineAligned != null
      ? `头条${details.headlineAligned ? "已换成状态那一包的最新节点" : "未换"}`
      : null,
    details.exitReason ? `提取结果 ${reasonText(details.exitReason)}` : null,
    details.durationMs != null ? `耗时 ${details.durationMs} ms` : null,
    details.executionBoundary
      ? `执行边界 ${executionBoundaryText(details.executionBoundary)}`
      : null,
    details.readbackMatched != null
      ? `回读${details.readbackMatched ? "一致" : "不一致"}`
      : null,
    details.result ? `结果 ${reasonText(details.result)}` : null,
    details.stage ? `阶段 ${stageText(details.stage)}` : null,
    details.errorCategory ? `原因 ${errorText(details.errorCategory)}` : null,
    details.httpStatus != null ? `HTTP ${details.httpStatus}` : null,
    details.authRuntime ? `签名运行时 ${details.authRuntime}` : null,
    failureText(item),
    details.flowId ? `流程 ${details.flowId}` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}

function levelColor(
  item: DiagnosticEntry,
): "systemRed" | "systemOrange" | "accentColor" {
  return item.level === "error"
    ? "systemRed"
    : item.level === "warning"
      ? "systemOrange"
      : "accentColor";
}

export function DiagnosticLogPage() {
  const [items, setItems] = useState(() => readDiagnostics());
  const [notice, setNotice] = useState("");
  const [recording, setRecording] = useState(() => diagnosticsEnabled());

  async function actions() {
    // 复制 and 清空 act on stored entries, so they are offered only when there are some. That makes
    // the sheet's indices depend on the log's state, hence the key list instead of fixed offsets.
    const latest = readDiagnostics();
    setItems(latest);
    // Two entries when the log is empty, three when it is not. This is also a live probe: the host
    // picks the presentation from the action count (one renders as a centred alert, three as a
    // bottom sheet) and two is untested, so beta23 exists to find out which side it lands on.
    // 清空 is the only action that is meaningless with an empty log; 复制 already answers with
    // 暂无可复制的日志, so keeping it costs nothing if two turns out to render as a sheet.
    const keys: Array<"toggle" | "copy" | "clear"> = latest.length
      ? ["toggle", "copy", "clear"]
      : ["toggle", "copy"];
    const labels = {
      toggle: { label: recording ? "停止记录" : "开始记录" },
      copy: { label: "复制日志" },
      clear: { label: "清空日志", destructive: true },
    } as const;
    const index = await Dialog.actionSheet({
      title: "诊断日志",
      message: "日志仅记录运单号尾 4 位，不包含手机号、验证码、Access Key、完整运单号、H5 地址或网络响应正文。",
      actions: keys.map((key) => labels[key]),
    });
    const action = index == null || index < 0 ? null : keys[index] ?? null;
    if (action === "toggle") {
      const next = !recording;
      if (!setDiagnosticsEnabled(next)) {
        setNotice("设置失败，请稍后重试");
        return;
      }
      setRecording(next);
      if (next) {
        writeRuntimeCapabilities("app");
        setItems(readDiagnostics());
      }
      setNotice(next ? "已开始记录" : "已停止记录");
    } else if (action === "copy") {
      const latestItems = readDiagnostics();
      setItems(latestItems);
      if (!latestItems.length) {
        setNotice("暂无可复制的日志");
        return;
      }
      const result = await copyText(diagnosticText(latestItems));
      setNotice(
        result === "copied"
          ? "日志已复制"
          : "复制失败，请稍后重试",
      );
    } else if (action === "clear") {
      const confirmed = await Dialog.confirm({
        title: "清空诊断日志",
        message: "清空后无法恢复。是否继续？",
        cancelLabel: "取消",
        confirmLabel: "清空",
      });
      if (!confirmed) return;
      try {
        clearDiagnostics();
        setItems([]);
        setNotice("日志已清空");
      } catch {
        setItems(readDiagnostics());
        setNotice("日志清空失败，请稍后重试");
      }
    }
  }

  return (
    <List
      navigationTitle="诊断日志"
      navigationBarTitleDisplayMode="inline"
      onAppear={() => {
        setItems(readDiagnostics());
        setRecording(diagnosticsEnabled());
      }}
      toast={transientToast(notice, setNotice)}
      toolbar={{
        topBarTrailing: (
          <Button buttonStyle="plain" action={actions}>
            <Image
              systemName="ellipsis.circle"
              font={17}
              frame={{ width: 44, height: 44 }}
            />
          </Button>
        ),
      }}
    >
      <Section
        footer={
          <Text font={12} foregroundStyle="secondaryLabel">
            仅采集必要的诊断信息，相关数据仅限本地存储与使用。
          </Text>
        }
      >
        {!items.length ? (
          <VStack
            spacing={8}
            padding={{ vertical: 28 }}
            frame={{ maxWidth: "infinity" }}
          >
            <Image
              systemName="doc.text.magnifyingglass"
              font={30}
              foregroundStyle="tertiaryLabel"
            />
            <Text font={15} fontWeight="medium">暂无诊断日志</Text>
          </VStack>
        ) : (
          items.map((item) => (
            <HStack
              key={item.id}
              spacing={10}
              alignment="top"
              padding={{ vertical: 5 }}
            >
              <Image
                systemName={
                  item.level === "error"
                    ? "xmark.circle.fill"
                    : item.level === "warning"
                      ? "exclamationmark.triangle.fill"
                      : "circle.fill"
                }
                foregroundStyle={levelColor(item)}
                frame={{ width: 18 }}
              />
              <VStack
                alignment="leading"
                spacing={4}
                frame={{ maxWidth: "infinity", alignment: "leading" }}
              >
                <HStack spacing={8} frame={{ maxWidth: "infinity" }}>
                  <Text font={14} fontWeight="semibold">
                    {eventTitle(item)}
                  </Text>
                  <Spacer />
                  <Text font={11} foregroundStyle="tertiaryLabel" monospacedDigit>
                    {timeText(item.at)}
                  </Text>
                </HStack>
                {detailsText(item) ? (
                  <Text font={12} foregroundStyle="secondaryLabel">
                    {detailsText(item)}
                  </Text>
                ) : null}
              </VStack>
            </HStack>
          ))
        )}
      </Section>
    </List>
  );
}
