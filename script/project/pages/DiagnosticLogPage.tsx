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
  readDiagnostics,
  type DiagnosticEntry,
} from "../services/logger";
import { copyText } from "../services/clipboard";
import { transientToast } from "../services/ui-feedback";

const EVENT_TITLES: Record<string, string> = {
  "app.state.applied": "页面状态已更新",
  "binding.flow.opened": "开始绑定手机号",
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
  "detail.route_publish_failed": "详情路由保存失败",
  "account.identity.generated": "已创建本机身份",
  "account.sync.parsed": "关联快递已解析",
  "account.sync.failed": "账号快递同步失败",
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
    account_detail: "账号详情",
    account_list: "账号列表",
    cainiao: "菜鸟",
    cainiao_h5: "菜鸟 H5",
    jingdong_h5: "京东 H5",
    kdniao_fallback: "备用轨迹查询",
    kuaidi100_query: "K100 H5 轨迹查询",
    local: "本地轨迹",
    route: "路线轨迹",
    fallback: "KDNiao",
    manual_fallback: "手动查询兜底",
    manual_refresh: "手动件刷新",
    manual_sources: "手动查件数据源",
    manual_source: "手动查件",
    pending_query: "待查件查询",
    none: "无",
    route_publish: "路由保存",
    primary_contest: "主数据源查询",
    moto_query: "本地轨迹查询",
    web_timeline: "H5 轨迹查询",
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
    cainiao: "菜鸟缓存",
    jingdong: "京东缓存",
    cainiao_h5: "菜鸟 H5",
    jingdong_h5: "京东 H5",
    account: "账号轨迹",
    web: "H5 轨迹",
    local: "Moto",
    moto: "Moto",
    route: "魅族 Picker",
    meizu: "魅族 Picker",
    fallback: "KDNiao",
    kdniao: "KDNiao",
    kuaidi100: "Kuaidi100",
    kuaidi100_h5: "K100 H5",
    interface5: "账号缓存",
    interface6: "账号缓存",
    none: "无",
  } as Record<string, string>)[value] || value;
}

function timelineProviderText(item: DiagnosticEntry): string | null {
  const provider = item.details.timelineProvider;
  if (!provider) return null;
  const value = providerText(provider);
  if (item.event === "manual.query.completed") return `选中数据源 ${value}`;
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

function reasonText(value: string): string {
  return ({
    account_record_missing: "缺少账号详情记录",
    background_host_webview_disabled: "后台宿主不允许网页提取",
    coalesced_detail_refresh: "详情刷新已在执行",
    deadline_exhausted: "刷新预算已用尽",
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
  } as Record<string, string>)[value] || value;
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
    hasSource ? "统一通道" : null,
    details.waybillTail ? `运单尾号 ${details.waybillTail}` : null,
    details.sourceProvider
      ? `自动来源 ${providerText(details.sourceProvider)}`
      : null,
    details.carrierCode ? `承运商 ${details.carrierCode}` : null,
    details.automatic != null
      ? details.automatic ? "自动件" : "手动件"
      : null,
    details.baseRevision != null ? `起始版本 ${details.baseRevision}` : null,
    details.revision != null ? `版本 ${details.revision}` : null,
    details.resultRevision != null ? `结果版本 ${details.resultRevision}` : null,
    details.interface5Bindings != null
      ? `绑定 ${details.interface5Bindings}`
      : null,
    details.attempted != null ? `尝试 ${details.attempted}` : null,
    details.succeeded != null ? `成功 ${details.succeeded}` : null,
    details.failed != null ? `失败 ${details.failed}` : null,
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
    details.evaluationAttempts != null
      ? `提取尝试 ${details.evaluationAttempts}`
      : null,
    details.evaluationFailures != null
      ? `提取异常 ${details.evaluationFailures}`
      : null,
    details.extractionSource
      ? `提取来源 ${details.extractionSource.toUpperCase()}`
      : null,
    details.rawTrackCount != null
      ? `原始轨迹 ${details.rawTrackCount}`
      : null,
    details.validTrackCount != null
      ? `有效轨迹 ${details.validTrackCount}`
      : null,
    details.effectiveTrackCount != null
      ? `当前轨迹 ${details.effectiveTrackCount}`
      : null,
    details.detailEffectiveTrackCount != null
      ? `详情轨迹 ${details.detailEffectiveTrackCount}`
      : null,
    details.motoSupported != null
      ? `Moto ${details.motoSupported ? "适用" : "不适用"}`
      : null,
    details.motoSucceeded != null
      ? `Moto ${details.motoSucceeded ? "成功" : "失败"}`
      : null,
    details.kuaidi100Succeeded != null
      ? `K100 ${details.kuaidi100Succeeded ? "成功" : "失败"}`
      : null,
    details.primarySuccessCount != null
      ? `主数据源成功 ${details.primarySuccessCount}`
      : null,
    details.kdniaoAttempted != null
      ? `KDNiao ${details.kdniaoAttempted ? "已调用" : "未调用"}`
      : null,
    details.kdniaoSucceeded != null
      ? `KDNiao ${details.kdniaoSucceeded ? "成功" : "失败"}`
      : null,
    details.persisted != null
      ? `结果${details.persisted ? "已写入" : "未写入"}`
      : null,
    timelineProviderText(item),
    details.finalTimelineProvider
      ? `列表数据源 ${providerText(details.finalTimelineProvider)}`
      : null,
    details.detailTimelineProvider
      ? `详情数据源 ${providerText(details.detailTimelineProvider)}`
      : null,
    details.skipReason ? `跳过原因 ${reasonText(details.skipReason)}` : null,
    details.exitReason ? `提取结果 ${reasonText(details.exitReason)}` : null,
    details.durationMs != null ? `耗时 ${details.durationMs}ms` : null,
    details.executionBoundary
      ? `执行边界 ${executionBoundaryText(details.executionBoundary)}`
      : null,
    details.readbackMatched != null
      ? `回读${details.readbackMatched ? "一致" : "不一致"}`
      : null,
    details.result ? `结果 ${reasonText(details.result)}` : null,
    details.stage ? `阶段 ${stageText(details.stage)}` : null,
    details.errorCategory ? `错误 ${details.errorCategory}` : null,
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

  async function actions() {
    const index = await Dialog.actionSheet({
      title: "诊断日志",
      message: "日志仅记录运单号尾 4 位，不包含手机号、验证码、Access Key、完整运单号、H5 地址或网络响应正文。",
      actions: [
        { label: "复制全部日志" },
        { label: "清空日志", destructive: true },
      ],
    });
    if (index === 0) {
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
    } else if (index === 1) {
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
      onAppear={() => setItems(readDiagnostics())}
      toast={transientToast(notice, setNotice)}
      toolbar={{
        topBarTrailing: (
          <Button buttonStyle="plain" action={actions}>
            <Image systemName="ellipsis.circle" font={17} />
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
                    {EVENT_TITLES[item.event] || item.event}
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
