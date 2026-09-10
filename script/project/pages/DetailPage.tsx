import {
  Button,
  HStack,
  Image,
  List,
  Section,
  Script,
  Spacer,
  Text,
  VStack,
  WebView,
  useEffect,
  useRef,
  useState,
} from "scripting";
import { registerProjectionViewportHost } from "../services/projection-viewport";
import { accountExternalAppName, fetchAccountExternalAppRoutes } from "../services/account-sync";
import { trackPhoneText } from "../services/track-phone-links";
import type { AppState, Shipment } from "../models";
import { CourierIcon } from "../components/CourierIcon";
import { courierHotline } from "../services/carrier-presentation";
import {
  continueManualShipmentPreview,
  refreshShipmentById,
  type ManualShipmentPreview,
} from "../services/sync";
import {
  displayWaybill,
  selectShipmentDetailTimeline,
  unprojectedAccountOrder,
} from "../services/shipment-policy";
import {
  isProviderErrorDetail,
  shipmentDetailPresentationStatus,
  statusTint,
  timedTracks,
  waybillSuffix,
  withShipmentNote,
} from "../services/status";
import { setShipmentNote } from "../services/storage";
import { requestWidgetReload } from "../services/widgets";
import { timelineTimeParts } from "../services/time-presentation";
import { preferNewerShipment } from "../services/ui-state";
import { manualPreviewNeedsDetailRefresh } from "../services/manual-preview";
import { copyText } from "../services/clipboard";
import {
  detailPullToast,
  manualDetailRefreshToast,
  transientToast,
} from "../services/ui-feedback";
import { EXPRESS_TOAST_COPY } from "../services/express-toast-copy";
import {
  diagnosticErrorDetails,
  writeDiagnostic,
} from "../services/logger";

/** 手动加件的查询链还没跑完时，状态词与轨迹区都写这个（用户定 2026-09-08 方案 2）。 */
const MANUAL_QUERY_IN_FLIGHT_TEXT = "查询中";

export function DetailPage(props: {
  shipment: Shipment;
  manualPreview?: ManualShipmentPreview | null;
  refreshOnAppear?:
    | "manual_submit"
    | "identity_projection"
    | "detail_open"
    | false;
  onStateChange?: (state: AppState, shipment: Shipment) => void;
}) {
  const [shipment, setShipment] = useState(props.shipment);
  const [notice, setNotice] = useState("");
  const [openingExternalApp, setOpeningExternalApp] = useState(false);
  const externalAppAbortRef = useRef<AbortController | null>(null);
  const externalAppName = accountExternalAppName(shipment);
  const timelineSourceIcon = shipment.identity.manuallyAdded
    ? "sources/kuaidi100"
    : ({ cainiao: "sources/cainiao", jingdong: "couriers/jdshopping", shunfeng: "sources/sfexpress" } as Record<string, string>)[
        String(shipment.identity.sourceProvider || "").toLowerCase()
      ];
  const timelineSourceName = shipment.identity.manuallyAdded
    ? "快递100"
    : ({ cainiao: "菜鸟", jingdong: "京东", shunfeng: "顺丰" } as Record<string, string>)[
        String(shipment.identity.sourceProvider || "").toLowerCase()
      ];
  useEffect(() => {
    setOpeningExternalApp(false);
    return () => {
      externalAppAbortRef.current?.abort();
      externalAppAbortRef.current = null;
    };
  }, [shipment.identity.id, shipment.identity.sourceProvider, shipment.identity.sourceId]);
  // 备注（用户定 2026-09-05 晚）：只在详情页添加，用系统弹窗输入；状态词后面以「 · 备注」显示。
  async function editNote() {
    let value: string | null;
    try {
      value = await Dialog.prompt({
        title: "备注",
        message: "为运单号添加备注，留空则删除",
        defaultValue: shipment.note || "",
        placeholder: "输入备注",
        cancelLabel: "取消",
        confirmLabel: "保存",
      });
    } catch (error) {
      writeDiagnostic("detail.note.prompt_failed", {
        ...diagnosticErrorDetails(error),
      }, "warning");
      return;
    }
    if (value == null) return;
    const state = setShipmentNote(shipment.identity.id, value);
    const updated = state.shipments.find(
      (item) => item.identity.id === shipment.identity.id,
    );
    if (updated) {
      setShipment(updated);
      props.onStateChange?.(state, updated);
    }
    requestWidgetReload();
  }
  const [loadingManualDetail, setLoadingManualDetail] = useState(
    props.refreshOnAppear === "manual_submit",
  );
  const refreshGenerationRef = useRef(0);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const refreshAbortRef = useRef<AbortController | null>(null);
  // D-15 裁决 A′ (2026-09-04): this page lends the JingDong projection a real viewport by
  // rendering its controller transparently behind the list. A headless controller reports a
  // 0×0 viewport, so the union page never mounts the 「完整物流进度」 control.
  const [projectionController, setProjectionController] = useState<unknown>(null);
  const projectionMountRef = useRef<Array<(mounted: boolean) => void>>([]);
  const detailTimeline = selectShipmentDetailTimeline(shipment);
  const displayTracks = detailTimeline.tracks.filter(
    (track) => Boolean(track.detail.trim()) && !isProviderErrorDetail(track.detail),
  );
  // 计数与渲染是两件事：渲染保留来源返回的每一行（AGENTS §9），可比较的「有效轨迹数」只数带时间的
  // 节点。sync.ts 的同名字段本来就用 timedTracks，Pipi 的 ExpressRepository.loadLocalDetail 也用
  // ExpressDetailTimelinePolicy.timedTrackCount(detailTracks)；页面自己再数一遍会让同一个包裹在
  // 诊断日志里出现两个「详情轨迹 N」。
  const effectiveTrackCount = timedTracks(detailTimeline.tracks).length;
  // The read-side display decision, recorded once per change rather than per render. Pipi emits
  // the same two events from ExpressRepository.loadLocalDetail; without them no log line says
  // which package the sheet is actually showing, or what it was weighed against.
  const selectionSignature = [
    detailTimeline.provider,
    String(detailTimeline.complete === true),
    String(displayTracks.length),
    String(effectiveTrackCount),
  ].join("|");
  useEffect(() => {
    // Same keys as sync.ts shipmentDiagnosticDetails so every express line reads alike; that
    // helper is module-private there, and importing sync into a page would be a heavy cycle.
    const identity = {
      waybillTail: waybillSuffix(displayWaybill(shipment)),
      automatic: !shipment.identity.manuallyAdded,
      sourceProvider: String(shipment.identity.sourceProvider || "")
        .trim()
        .toLowerCase(),
      carrierCode: String(shipment.identity.courierCode || "").trim().toUpperCase(),
      statusSemantic: String(shipment.timeline.semantic || "").trim().toUpperCase(),
    };
    const candidates = [
      ...(shipment.sourceTimeline ? [shipment.sourceTimeline] : []),
      ...(shipment.manualTimelines || []),
    ];
    writeDiagnostic("detail.timeline.selected", {
      ...identity,
      stage: "detail_refresh",
      detailTimelineProvider: detailTimeline.provider,
      detailEffectiveTrackCount: effectiveTrackCount,
      result: effectiveTrackCount === 0
        ? "no_result"
        : detailTimeline.complete === true
        ? "complete"
        : "partial",
      attempted: candidates.length,
      succeeded: candidates.filter(
        (timeline) => timedTracks(timeline.tracks).length > 0,
      ).length,
      selected: true,
    });
    for (const candidate of candidates) {
      writeDiagnostic("detail.timeline.candidate", {
        ...identity,
        stage: "detail_refresh",
        timelineProvider: candidate.provider,
        effectiveTrackCount: timedTracks(candidate.tracks).length,
        result: candidate.complete === true ? "complete" : "partial",
      });
    }
  }, [shipment.identity.id, selectionSignature]);
  // 承运商只有一份：identity。列表行、小组件、通知都读它，repairProjectedShipmentCarrier 也只维护
  // 它（D-6）。详情页曾在 kuaidi100_h5 包裹上改读包裹自带的承运商，那份是抓取当时写死的，修复过的
  // identity 不会回头改它，于是同一单在列表里是真承运商、在详情页仍是泄漏的京东快递。
  const hotline = courierHotline(
    shipment.identity.courierCode,
    shipment.identity.companyName,
  );
  const waybill = displayWaybill(shipment);
  // 用户定 2026-09-08 方案 2：手动加件先建行再跳详情页，picker 之后的级别是在页面打开之后才跑的
  // （实测尾号 2410 空窗 3.2 s、尾号 1107 空窗 8 s）。链条没跑完的这段不能写「暂无状态 · 暂无物流
  // 轨迹」——那读起来像查不到；写「查询中」。跑完还是没有轨迹时，照旧回到「暂无」。
  const presentationStatus = shipmentDetailPresentationStatus(
    shipment,
    detailTimeline,
  );
  const statusText = loadingManualDetail &&
      presentationStatus.semantic === "UNKNOWN"
    ? MANUAL_QUERY_IN_FLIGHT_TEXT
    : presentationStatus.text;

  useEffect(() => {
    setShipment((current) => preferNewerShipment(current, props.shipment));
  }, [props.shipment.identity.id, props.shipment.updatedAtMs]);

  useEffect(() => {
    const settle = (mounted: boolean) => {
      const pending = projectionMountRef.current.splice(0);
      pending.forEach((resolve) => resolve(mounted));
    };
    registerProjectionViewportHost({
      mount: (controller) =>
        new Promise<boolean>((resolve) => {
          projectionMountRef.current.push(resolve);
          setProjectionController(controller);
        }),
      unmount: () => {
        settle(false);
        setProjectionController(null);
      },
    });
    return () => {
      // A page that is going away cannot host anything; the projection continues headless.
      registerProjectionViewportHost(null);
      settle(false);
    };
  }, []);

  useEffect(() => {
    if (!projectionController) return;
    // The slot is on screen now, so the borrower may start loading.
    projectionMountRef.current.splice(0).forEach((resolve) => resolve(true));
  }, [projectionController]);

  useEffect(() => {
    // 卸载时的取消无条件注册：不自动刷新的进入方式下，用户下拉刷新后退出页面，请求也要跟着作废，
    // 否则完成后还会改页面状态、弹提示（2026-09-06 静态审查发现）。
    if (props.refreshOnAppear) {
      if (props.refreshOnAppear === "manual_submit") {
        setLoadingManualDetail(true);
      }
      void refresh(false);
    }
    return () => {
      refreshGenerationRef.current += 1;
      refreshAbortRef.current?.abort();
      refreshAbortRef.current = null;
      refreshInFlightRef.current = null;
    };
  }, [props.shipment.identity.id, props.refreshOnAppear]);

  function refresh(forceManualRefresh = false): Promise<void> {
    if (refreshInFlightRef.current) return refreshInFlightRef.current;
    const generation = refreshGenerationRef.current + 1;
    refreshGenerationRef.current = generation;
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    const task = (async () => {
      setNotice("");
      try {
        const result = props.refreshOnAppear === "manual_submit" &&
            props.manualPreview?.roundComplete === false &&
            !forceManualRefresh
          ? await continueManualShipmentPreview(props.manualPreview, {
              signal: controller.signal,
              onPreview: (preview) => {
                if (controller.signal.aborted || generation !== refreshGenerationRef.current) return;
                setShipment((current) => preferNewerShipment(current, preview));
                setLoadingManualDetail(manualPreviewNeedsDetailRefresh(preview));
              },
            })
          : await refreshShipmentById(props.shipment.identity.id, {
            forceAccountOrderProjection:
              forceManualRefresh || props.refreshOnAppear === "identity_projection",
            forceManualRefresh,
            includeKdniaoFallback:
              forceManualRefresh ||
              props.refreshOnAppear === "manual_submit" ||
              props.refreshOnAppear === "identity_projection" ||
              props.refreshOnAppear === "detail_open",
            trigger: forceManualRefresh
              ? "detail_pull"
              : props.refreshOnAppear || "detail_open",
            signal: controller.signal,
          });
        if (generation !== refreshGenerationRef.current) return;
        setShipment((current) => preferNewerShipment(current, result.shipment));
        props.onStateChange?.(result.state, result.shipment);
        const hasUsableDetail = selectShipmentDetailTimeline(
          result.shipment,
        ).tracks.some(
          (track) =>
            Boolean(track.detail.trim()) &&
            !isProviderErrorDetail(track.detail),
        );
        if (result.expressToast) {
          // Unified express toast (AGENTS §11): a typed key rendered from the shared copy table,
          // e.g. JD risk control; provider free-text feedback still never reaches the page.
          setNotice(EXPRESS_TOAST_COPY[result.expressToast]);
        } else if (props.refreshOnAppear === "manual_submit") {
          setNotice(manualDetailRefreshToast(
            result.refreshed,
            hasUsableDetail,
          ));
        } else if (forceManualRefresh) {
          setNotice(detailPullToast(result.refreshed, hasUsableDetail));
        }
      } catch (error) {
        if (generation === refreshGenerationRef.current) {
          const errorDetails = diagnosticErrorDetails(error);
          if (errorDetails.errorCategory === "removed") return;
          writeDiagnostic("detail.refresh.ui_failed", {
            trigger: forceManualRefresh
              ? "detail_pull"
              : props.refreshOnAppear || "detail_open",
            ...errorDetails,
          }, "warning");
          if (!displayTracks.length) {
            setNotice(EXPRESS_TOAST_COPY.detailRefreshFailed);
          }
        }
      } finally {
        if (
          generation === refreshGenerationRef.current &&
          !forceManualRefresh &&
          props.refreshOnAppear === "manual_submit"
        ) {
          setLoadingManualDetail(false);
        }
      }
    })();
    refreshInFlightRef.current = task;
    void task.then(() => {
      if (refreshInFlightRef.current === task) {
        refreshInFlightRef.current = null;
      }
      if (refreshAbortRef.current === controller) {
        refreshAbortRef.current = null;
      }
    });
    return task;
  }

  async function copyWaybill() {
    const result = await copyText(waybill);
    setNotice(
      result === "copied"
        ? EXPRESS_TOAST_COPY.waybillCopied
        : EXPRESS_TOAST_COPY.copyFailed,
    );
  }

  /** 官方电话：交给系统拨号，打不开就按统一表提示（三端同一条，AGENTS §11）。 */
  async function dialPhone(phone: string) {
    let opened = false;
    try {
      opened = await Safari.openURL(`tel:${phone}`);
    } catch {
      opened = false;
    }
    if (!opened) setNotice(EXPRESS_TOAST_COPY.dialUnavailable);
  }

  async function dial() {
    await dialPhone(hotline);
  }

  async function openExternalApp() {
    if (externalAppAbortRef.current || !externalAppName) return;
    const controller = new AbortController();
    externalAppAbortRef.current = controller;
    setOpeningExternalApp(true);
    try {
      const targets = await fetchAccountExternalAppRoutes(shipment, controller.signal);
      if (controller.signal.aborted) return;
      if (!targets.length) {
        setNotice(`来源暂未提供可用的${externalAppName} App 链接`);
        return;
      }
      for (const [index, target] of targets.entries()) {
        if (controller.signal.aborted) return;
        let opened = false;
        let result = "no_handler";
        try {
          opened = await Safari.openURL(target.url);
          result = opened ? "opened" : "no_handler";
        } catch {
          result = "open_failed";
        }
        writeDiagnostic("detail.external.open", {
          stage: target.kind, attempted: index + 1, result,
        }, opened ? "info" : "warning");
        if (opened || controller.signal.aborted) return;
      }
      setNotice(externalAppName === "菜鸟"
        ? "未能打开菜鸟、淘宝或支付宝，请确认已安装其中一个 App"
        : `无法打开${externalAppName} App，请确认已安装`);
    } catch {
      if (!controller.signal.aborted) setNotice(`打开${externalAppName}失败，请重试`);
    } finally {
      if (externalAppAbortRef.current === controller) {
        externalAppAbortRef.current = null;
        setOpeningExternalApp(false);
      }
    }
  }

  return (
    <List
      navigationTitle="物流详情"
      navigationBarTitleDisplayMode="inline"
      toolbar={externalAppName ? {
        topBarTrailing: (
          <Button
            title={openingExternalApp ? "正在打开…" : "在外部 App 中打开"}
            systemImage="arrow.up.forward.app"
            disabled={openingExternalApp}
            action={openExternalApp}
          />
        ),
      } : undefined}
      refreshable={() => refresh(true)}
      toast={transientToast(notice, setNotice)}
      background={
        projectionController
          ? {
              alignment: "topLeading",
              // Fully transparent, non-interactive and behind every row: the page only lends
              // its bounds so the union page has a viewport (D-15 裁决 A′).
              content: (
                <WebView
                  controller={projectionController}
                  frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
                  opacity={0}
                  disabled={true}
                />
              ),
            }
          : undefined
      }
    >
      <Section>
        <HStack spacing={14} padding={{ vertical: 12 }}>
          <CourierIcon
            courierCode={shipment.identity.courierCode}
            companyName={shipment.identity.companyName}
            accountOrder={Boolean(
              unprojectedAccountOrder(shipment),
            )}
            size={72}
            cornerRadius={17}
          />
          <VStack alignment="leading" spacing={4} frame={{ maxWidth: "infinity" }}>
            <HStack alignment="center" spacing={6}>
              <Text
                font={17}
                fontWeight="bold"
                foregroundStyle={statusTint(presentationStatus.semantic)}
                lineLimit={1}
              >
                {withShipmentNote(statusText, shipment)}
              </Text>
              <Button buttonStyle="plain" action={() => void editNote()}>
                <Image
                  systemName={shipment.note ? "note.text" : "square.and.pencil"}
                  font={13}
                  foregroundStyle="secondaryLabel"
                />
              </Button>
            </HStack>
            <HStack
              alignment="center"
              spacing={0}
              frame={{ maxWidth: "infinity", alignment: "leading" }}
            >
              <Text font={15}>{shipment.identity.companyName}：</Text>
              <HStack alignment="center" spacing={5}>
                <Text
                  font={15}
                  monospacedDigit
                  lineLimit={1}
                  minScaleFactor={0.65}
                  allowsTightening={true}
                  layoutPriority={1}
                >
                  {waybill}
                </Text>
                <Button buttonStyle="plain" action={copyWaybill}>
                  <Image
                    systemName="doc.on.doc"
                    font={13}
                    foregroundStyle="secondaryLabel"
                  />
                </Button>
              </HStack>
            </HStack>
            {hotline ? (
              <HStack spacing={0}>
                <Text font={15}>官方电话：</Text>
                <Button buttonStyle="plain" action={dial}>
                  <Text font={15} foregroundStyle="systemBlue" monospacedDigit>
                    {hotline}
                  </Text>
                </Button>
                <Spacer />
              </HStack>
            ) : null}
          </VStack>
          <Spacer />
        </HStack>
      </Section>

      <Section
        header={
          <HStack spacing={6}>
            {timelineSourceIcon ? (
              <Image filePath={`${Script.directory}/assets/${timelineSourceIcon}.png`}
                resizable scaleToFit frame={{ width: 16, height: 16 }} />
            ) : null}
            <HStack spacing={0}>
              <Text>{timelineSourceName ? "物流信息来自" : "物流信息"}</Text>
              {timelineSourceName ? <Text fontWeight="bold">{timelineSourceName}</Text> : null}
            </HStack>
          </HStack>
        }
        footer={(
          <Text
            font={12}
            foregroundStyle="tertiaryLabel"
            frame={{ maxWidth: "infinity", alignment: "center" }}
          >
            {loadingManualDetail
              ? "完整轨迹加载中"
              : "轨迹不完整时，可尝试下拉刷新。"}
          </Text>
        )}
      >
        {displayTracks.length ? (
          displayTracks.map((track, index) => {
            const time = timelineTimeParts(track.timeText);
            return (
              <HStack
                key={`${track.timeText}:${track.detail}:${index}`}
                alignment="top"
                spacing={11}
                padding={{ vertical: 5 }}
              >
                <VStack
                  alignment="trailing"
                  spacing={2}
                  frame={{ width: 52, alignment: "trailing" }}
                >
                  <Text font={14} fontWeight="medium" monospacedDigit lineLimit={1}>
                    {time.time || "--:--"}
                  </Text>
                  {time.date ? (
                    <Text font={11} foregroundStyle="tertiaryLabel" monospacedDigit>
                      {time.date}
                    </Text>
                  ) : null}
                </VStack>
                <Image
                  systemName={index === 0 ? "circle.fill" : "circle"}
                  font={10}
                  foregroundStyle={
                    index === 0
                      ? statusTint(presentationStatus.semantic)
                      : "tertiaryLabel"
                  }
                  frame={{ width: 12 }}
                />
                <Text
                  font={15}
                  foregroundStyle={index === 0 ? "label" : "secondaryLabel"}
                  frame={{ maxWidth: "infinity", alignment: "leading" }}
                  styledText={trackPhoneText(track.detail, (phone) => { void dialPhone(phone); })}
                />
              </HStack>
            );
          })
        ) : (
          <VStack
            spacing={8}
            padding={{ vertical: 26 }}
            frame={{ maxWidth: "infinity" }}
          >
            <Image
              systemName="clock.arrow.circlepath"
              font={28}
              foregroundStyle="tertiaryLabel"
            />
            <Text font={14} foregroundStyle="secondaryLabel">
              {loadingManualDetail ? MANUAL_QUERY_IN_FLIGHT_TEXT : "暂无物流轨迹"}
            </Text>
          </VStack>
        )}
      </Section>
    </List>
  );
}
