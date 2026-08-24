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
  "detail.refresh.skipped": "详情无需刷新",
  "detail.refresh.committed": "详情已更新",
  "detail.refresh.failed": "详情刷新失败",
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
  "refresh.started": "快递同步开始",
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
    details.durationMs != null ? `耗时 ${details.durationMs}ms` : null,
    details.readbackMatched != null
      ? `回读${details.readbackMatched ? "一致" : "不一致"}`
      : null,
    details.result ? `结果 ${details.result}` : null,
    details.stage ? `阶段 ${details.stage}` : null,
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
      message: "日志不包含手机号、验证码、Access Key、运单号或网络响应正文。",
      actions: [
        { label: "复制全部日志" },
        { label: "清空日志", destructive: true },
      ],
    });
    if (index === 0) {
      if (!items.length) {
        setNotice("暂无日志可复制");
        return;
      }
      const result = await copyText(diagnosticText(items));
      setNotice(
        result === "copied"
          ? "日志已复制"
          : "日志复制失败，请稍后重试",
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
            诊断日志仅保存在本机，最多保留 100 条，最长保留 7 天。不会上传，也不记录手机号、验证码、Access Key、运单号或响应正文。
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
            <Text font={12} foregroundStyle="secondaryLabel">
              复现问题后，可返回此页面复制日志
            </Text>
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
