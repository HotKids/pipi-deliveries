import {
  AbortController,
  Button,
  HStack,
  Image,
  List,
  Section,
  Spacer,
  Text,
  VStack,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "scripting";
import { accountExternalAppName, fetchAccountExternalAppRoutes } from "../services/account-sync";
import { accountKuaidi100URL, kuaidi100MiniProgramURL, shunfengKuaidi100FallbackURL } from "../services/kuaidi100-app-link";
import { trackPhoneText } from "../services/track-phone-links";
import type { AccountBinding, AppState, Shipment } from "../models";
import { ProductThumbnail } from "../components/ProductThumbnail";
import { bundledImage } from "../components/bundled-image";
import { productImageCacheKey } from "../services/product-image-cache";
import { SenderBadge } from "../components/SenderBadge";
import { carrierDisplayName, courierHotline } from "../services/carrier-presentation";
import {
  continueManualShipmentPreview,
  refreshShipmentById,
  shouldRequestDetailProductImage,
  hasActiveAccountOrderProjection,
  type ManualShipmentPreview,
  type DetailEntryObservation,
} from "../services/sync";
import {
  displayWaybill,
  jingDongOrderStagePrepended,
  shipmentDetailCandidateEvidence,
  selectShipmentDetailPresentation,
  selectShipmentDetailTimeline,
  shipmentDetailIncompleteReason,
  shipmentSelectionEvidence,
  unprojectedAccountOrder,
} from "../services/shipment-policy";
import {
  isProviderErrorDetail,
  latestTimelineTrackSemantic,
  normalizeWaybill,
  shipmentDetailPhoneTail,
  shipmentDetailPresentationStatus,
  statusTint,
  statusTextTint,
  timedTracks,
  trackDisplayDetail,
  timelineLatestEventAt,
  timelineLatestTrackAt,
  waybillSuffix,
} from "../services/status";
import { loadState, recordShipmentDetailSelection, setShipmentNote, setShipmentProductName, visibleShipments } from "../services/storage";
import { ShipmentLifecycleChangedError, shipmentLifecycleKey } from "../services/shipment-lifecycle";
import { requestWidgetReload } from "../services/widgets";
import { displayedPlatformFields, type CloudParcelMetadata } from "../services/platform-parcel-merge";
import { readCloudParcelMetadata } from "../services/cloud-parcel-metadata";
import { gatewayCredentialGeneration } from "../services/credentials";
import { SCRIPT_BUILD_TRACK } from "../services/build-track";
import { parcelActivityContent } from "../services/parcel-pickup";
import { timelineTimeParts } from "../services/time-presentation";
import { preferNewerShipment } from "../services/ui-state";
import { manualPreviewNeedsDetailRefresh } from "../services/manual-preview";
import { needsManualPhoneTail } from "../services/jt-h5";
import { copyText } from "../services/clipboard";
import {
  detailPullToast,
  manualDetailRefreshToast,
  transientToast,
} from "../services/ui-feedback";
import { EXPRESS_TOAST_COPY, jdRiskControlRetryText } from "../services/express-toast-copy";
import {
  diagnosticErrorDetails,
  writeDiagnostic,
} from "../services/logger";

/** 手动加件的查询链还没跑完时，状态词与轨迹区都写这个（用户定 2026-09-08 方案 2）。 */
const MANUAL_QUERY_IN_FLIGHT_TEXT = "查询中";
const EMPTY_ATTACHED_ORDERS: readonly Shipment[] = [];

export function DetailPage(props: {
  shipment: Shipment;
  persistedShipment?: boolean;
  accountBinding?: AccountBinding;
  manualPreview?: ManualShipmentPreview | null;
  refreshOnAppear?:
    | "manual_submit"
    | "identity_projection"
    | "detail_open"
    | false;
  onStateChange?: (state: AppState, shipment: Shipment) => void;
  /** 归属-2：挂靠在这一行后面的投影订单；只用来在详情页接上它们更早的订单阶段节点。 */
  attachedOrders?: readonly Shipment[];
}) {
  const [shipment, setShipment] = useState(props.shipment);
  const [notice, setNotice] = useState("");
  const [cloud, setCloud] = useState<{ scope: string; metadata: CloudParcelMetadata } | undefined>(undefined);
  const cloudAbortRef = useRef<AbortController | null>(null);
  const [openingExternalApp, setOpeningExternalApp] = useState(false);
  const externalAppAbortRef = useRef<AbortController | null>(null);
  const accountBindingRef = useRef(props.accountBinding);
  const accountExternalAppURL = props.persistedShipment
    ? accountKuaidi100URL(shipment, shipment, accountBindingRef.current, props.accountBinding) : "";
  const manualExternalAppURL = props.persistedShipment && shipment.identity.manuallyAdded
    ? kuaidi100MiniProgramURL(displayWaybill(shipment))
    : "";
  const externalAppName = manualExternalAppURL || accountExternalAppURL ? "快递100" : accountExternalAppName(shipment);
  const timelineSourceIconPath = shipment.identity.manuallyAdded
    ? "sources/kuaidi100"
    : ({ cainiao: "sources/cainiao", jingdong: "couriers/jdshopping", shunfeng: "sources/sfexpress" } as Record<string, string>)[
        String(shipment.identity.sourceProvider || "").toLowerCase()
      ];
  const timelineSourceIcon = timelineSourceIconPath ? bundledImage(`${timelineSourceIconPath}.png`) : undefined;
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
  async function editNote() {
    if (!props.persistedShipment) return;
    let value: string | null;
    try {
      value = await Dialog.prompt({
        title: "编辑备注",
        message: "清空后保存可删除备注",
        defaultValue: shipment.note || "",
        placeholder: "请输入备注",
        cancelLabel: "取消",
        confirmLabel: "保存",
      });
    } catch (error) {
      writeDiagnostic("detail.note.prompt_failed", diagnosticErrorDetails(error), "warning");
      return;
    }
    if (value == null) return;
    try {
      const state = setShipmentNote(shipment, value);
      const updated = state.shipments.find((item) => item.identity.id === shipment.identity.id);
      if (updated) {
        setShipment(updated);
        props.onStateChange?.(state, updated);
      }
      requestWidgetReload();
    } catch (error) {
      writeDiagnostic("detail.note.save_failed", diagnosticErrorDetails(error), "warning");
      setNotice(error instanceof ShipmentLifecycleChangedError
        ? "快递已更新，请重新打开后编辑" : "保存失败，请稍后重试");
    }
  }

  async function editProductName() {
    let value: string | null;
    try {
      value = await Dialog.prompt({
        title: "编辑商品名",
        message: "清空后恢复平台提供的商品名。",
        defaultValue: platformFields.title || "",
        placeholder: "请输入商品名",
        cancelLabel: "取消",
        confirmLabel: "保存",
      });
    } catch (error) {
      writeDiagnostic("detail.product_name.prompt_failed", {
        ...diagnosticErrorDetails(error),
      }, "warning");
      return;
    }
    if (value == null) return;
    try {
      const state = setShipmentProductName(shipment, value);
      const updated = state.shipments.find(
        (item) => item.identity.id === shipment.identity.id,
      );
      if (updated) {
        setShipment(updated);
        props.onStateChange?.(state, updated);
        setNotice("商品名已更新");
      }
      requestWidgetReload();
    } catch (error) {
      writeDiagnostic("detail.product_name.save_failed", diagnosticErrorDetails(error), "warning");
      setNotice(error instanceof ShipmentLifecycleChangedError
        ? "快递已更新，请重新打开后编辑" : "保存失败，请稍后重试");
    }
  }
  const [loadingManualDetail, setLoadingManualDetail] = useState(
    props.refreshOnAppear === "manual_submit",
  );
  const refreshGenerationRef = useRef(0);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const productImageRequestRef = useRef<Promise<void> | null>(null);
  const detailEntryRef = useRef<DetailEntryObservation | undefined>(undefined);
  const pullInFlightRef = useRef<Promise<void> | null>(null);
  const joinedJdPullRef = useRef(false);
  const recordedSelectionKeyRef = useRef("");
  const attachedOrders = props.attachedOrders ?? EMPTY_ATTACHED_ORDERS;
  const detailPresentation = useMemo(
    () => selectShipmentDetailPresentation(shipment, attachedOrders),
    [shipment, attachedOrders],
  );
  const detailTimeline = detailPresentation;
  const displayTracks = detailTimeline.tracks.filter(
    (track) => Boolean(track.detail.trim()) && !isProviderErrorDetail(track.detail),
  );
  // 计数与渲染是两件事：渲染保留来源返回的每一行（AGENTS §9），可比较的「有效轨迹数」只数带时间的
  // 节点。sync.ts 的同名字段本来就用 timedTracks，Pipi 的 ExpressRepository.loadLocalDetail 也用
  // ExpressDetailTimelinePolicy.timedTrackCount(detailTracks)；页面自己再数一遍会让同一个包裹在
  // 诊断日志里出现两个「详情轨迹 N」。
  const effectiveTrackCount = timedTracks(detailTimeline.tracks).length;
  const incompleteReason = shipmentDetailIncompleteReason(shipment);
  const detailComplete = incompleteReason === null;
  const latestTrackSemantic = latestTimelineTrackSemantic(detailTimeline.tracks);
  // The read-side display decision, recorded once per change rather than per render. Pipi emits
  // the same two events from ExpressRepository.loadLocalDetail; without them no log line says
  // which package the sheet is actually showing, or what it was weighed against.
  const selectionSignature = [
    String(shipment.updatedAtMs),
    detailTimeline.provider,
    String(detailTimeline.complete === true),
    String(displayTracks.length),
    String(effectiveTrackCount),
    String(detailComplete),
    incompleteReason || "",
    shipment.timeline.semantic,
    latestTrackSemantic,
    detailTimeline.latestTimeText,
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
      trigger: "cache_read",
    };
    const candidates = [
      ...(shipment.sourceTimeline ? [shipment.sourceTimeline] : []),
      ...(shipment.manualTimelines || []),
    ];
    writeDiagnostic("detail.timeline.selected", {
      ...identity,
      ...shipmentSelectionEvidence(shipment),
      stage: "detail_refresh",
      detailTimelineProvider: detailTimeline.provider,
      detailComplete,
      incompleteReason: incompleteReason ?? undefined,
      latestTrackSemantic,
      latestEventAtMs: timelineLatestEventAt(detailTimeline),
      latestTrackAtMs: timelineLatestTrackAt(detailTimeline),
      feedEventAtMs: shipment.sourceTimeline ? timelineLatestEventAt(shipment.sourceTimeline) : 0,
      statusEventAtMs: detailTimeline.statusEventAtMs || 0,
      orderStagePrepended: jingDongOrderStagePrepended(shipment, attachedOrders, detailPresentation),
      detailEffectiveTrackCount: effectiveTrackCount,
      result: effectiveTrackCount === 0
        ? "no_result"
        : detailComplete
        ? "complete"
        : "partial",
      candidateCount: candidates.length,
      availableCandidateCount: candidates.filter(
        (timeline) => timedTracks(timeline.tracks).length > 0,
      ).length,
      selected: true,
    });
    for (const candidate of candidates) {
      writeDiagnostic("detail.timeline.candidate", {
        ...identity,
        stage: "detail_refresh",
        timelineProvider: candidate.provider,
        statusSemantic: candidate.semantic,
        structuredStatus: candidate.structuredStatus === true,
        latestEventAtMs: timelineLatestEventAt(candidate),
        latestTrackAtMs: timelineLatestTrackAt(candidate),
        statusEventAtMs: candidate.statusEventAtMs || 0,
        latestTrackSemantic: latestTimelineTrackSemantic(candidate.tracks),
        effectiveTrackCount: timedTracks(candidate.tracks).length,
        captureComplete: candidate.complete === true,
        ...shipmentDetailCandidateEvidence(shipment, candidate),
        result: timedTracks(candidate.tracks).length > 0 ? "available" : "empty",
      });
    }
    // The package on screen becomes the sticky selection (audit D7, adopted 2026-09-25). A manual query
    // preview is not a stored row and records nothing.
    const selectionProvider = detailTimeline.provider.trim().toLowerCase();
    const selectionWaybill = normalizeWaybill(detailTimeline.waybill || displayWaybill(shipment));
    const selectionKey = `${shipment.identity.id}|${selectionProvider}|${selectionWaybill}`;
    const selectionUnchanged =
      !selectionProvider ||
      recordedSelectionKeyRef.current === selectionKey ||
      (shipment.detailSelection?.provider.trim().toLowerCase() === selectionProvider &&
        (!shipment.detailSelection.waybill ||
          normalizeWaybill(shipment.detailSelection.waybill) === selectionWaybill));
    if (!selectionUnchanged) {
      if (!props.manualPreview) {
        try {
          recordShipmentDetailSelection(shipment.identity.id);
          recordedSelectionKeyRef.current = selectionKey;
        } catch (error) {
          writeDiagnostic("detail.selection.record_failed", diagnosticErrorDetails(error), "warning");
        }
      }
    } else {
      recordedSelectionKeyRef.current = selectionKey;
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
  const phoneTail = shipmentDetailPhoneTail(shipment);
  const cloudWaybill = SCRIPT_BUILD_TRACK === "formal" && props.persistedShipment && !unprojectedAccountOrder(shipment)
    ? normalizeWaybill(displayWaybill(shipment)) : "";
  const cloudGeneration = /^[A-Z0-9]{6,64}$/.test(cloudWaybill) ? gatewayCredentialGeneration() : null;
  const cloudLifecycle = shipmentLifecycleKey(shipment);
  const cloudScope = cloudGeneration === null ? "" : JSON.stringify([cloudGeneration, cloudWaybill, cloudLifecycle]);
  const platformFields = displayedPlatformFields(shipment, Date.now(), cloud?.scope === cloudScope ? cloud?.metadata : undefined);
  const note = shipment.note?.trim();
  const showParcelInfo = Boolean(platformFields.estimate || platformFields.title || note);
  const productNameMenu = props.persistedShipment ? {
    menuItems: <Button title="编辑商品名" action={() => void editProductName()} />,
  } : undefined;
  const pickup = parcelActivityContent(shipment);

  async function refreshCloudMetadata(): Promise<void> {
    if (!cloudScope) return;
    cloudAbortRef.current?.abort();
    const controller = new AbortController();
    cloudAbortRef.current = controller;
    try {
      const ownsWaybill = () => {
        const matches = visibleShipments(loadState()).filter(item =>
          !unprojectedAccountOrder(item) && normalizeWaybill(displayWaybill(item)) === cloudWaybill);
        return matches.length === 1 && shipmentLifecycleKey(matches[0]) === cloudLifecycle;
      };
      const metadata = ownsWaybill() ? await readCloudParcelMetadata(cloudWaybill, controller.signal) : undefined;
      if (controller.signal.aborted) return;
      const current = metadata && gatewayCredentialGeneration() === cloudGeneration && ownsWaybill();
      setCloud(current ? { scope: cloudScope, metadata } : undefined);
    } catch {
      if (!controller.signal.aborted) setCloud(undefined);
    }
  }

  useEffect(() => {
    void refreshCloudMetadata();
    return () => cloudAbortRef.current?.abort();
  }, [cloudScope]);

  useEffect(() => {
    setShipment((current) => preferNewerShipment(current, props.shipment));
  }, [props.shipment.identity.id, props.shipment.updatedAtMs]);

  useEffect(() => {
    // 卸载时的取消无条件注册：不自动刷新的进入方式下，用户下拉刷新后退出页面，请求也要跟着作废，
    // 否则完成后还会改页面状态、弹提示（2026-09-06 静态审查发现）。
    if (props.refreshOnAppear) {
      if (props.refreshOnAppear === "manual_submit") {
        setLoadingManualDetail(true);
      }
      void refresh(false);
    } else {
      void refreshProductImage(props.shipment, refreshGenerationRef.current);
    }
    return () => {
      refreshGenerationRef.current += 1;
      refreshAbortRef.current?.abort();
      refreshAbortRef.current = null;
      refreshInFlightRef.current = null;
      productImageRequestRef.current = null;
      pullInFlightRef.current = null;
      joinedJdPullRef.current = false;
      detailEntryRef.current = undefined;
    };
  }, [props.shipment.identity.id]);

  function refresh(forceManualRefresh = false): Promise<void> {
    if (forceManualRefresh && pullInFlightRef.current) return pullInFlightRef.current;
    if (refreshInFlightRef.current) {
      if (!forceManualRefresh) return refreshInFlightRef.current;
      // Only an actual capture can consume this gesture; an entry query may still be refused by automatic gates.
      if (hasActiveAccountOrderProjection(props.shipment.identity.id)) {
        joinedJdPullRef.current = true;
        return refreshInFlightRef.current;
      }
      const generation = refreshGenerationRef.current;
      // A pull waits for this page's entry request, then starts the distinct history operation once.
      const pending = refreshInFlightRef.current.then(() => {
        if (generation !== refreshGenerationRef.current) return;
        pullInFlightRef.current = null;
        return refresh(true);
      });
      pullInFlightRef.current = pending;
      return pending;
    }
    const generation = refreshGenerationRef.current + 1;
    joinedJdPullRef.current = false;
    refreshGenerationRef.current = generation;
    const previousImage = productImageRequestRef.current;
    refreshAbortRef.current?.abort();
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    let imageShipment: Shipment | undefined;
    const task = (async () => {
      setNotice("");
      try {
        // Cancelling the page's optional image request releases its lease before the necessary trajectory request.
        if (previousImage) await previousImage;
        if (controller.signal.aborted || generation !== refreshGenerationRef.current) return;
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
            requestProductImage: false,
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
              : props.refreshOnAppear || "product_image",
            signal: controller.signal,
            detailEntry: detailEntryRef.current,
          });
        if (generation !== refreshGenerationRef.current) return;
        if (result.detailEntry) detailEntryRef.current = result.detailEntry;
        setShipment((current) => preferNewerShipment(current, result.shipment));
        props.onStateChange?.(result.state, result.shipment);
        imageShipment = result.shipment;
        const hasUsableDetail = selectShipmentDetailTimeline(
          result.shipment,
        ).tracks.some(
          (track) =>
            Boolean(track.detail.trim()) &&
            !isProviderErrorDetail(track.detail),
        );
        if ((forceManualRefresh || joinedJdPullRef.current) && result.expressToastRemainingMs) {
          setNotice(jdRiskControlRetryText(result.expressToastRemainingMs));
        } else if (result.expressToast) {
          // Unified express toast (AGENTS §11): a typed key rendered from the shared copy table,
          // e.g. JD risk control; provider free-text feedback still never reaches the page.
          setNotice(EXPRESS_TOAST_COPY[result.expressToast]);
        } else if (props.refreshOnAppear === "manual_submit") {
          setNotice(manualDetailRefreshToast(
            result.refreshed,
            hasUsableDetail,
          ));
        } else if (forceManualRefresh) {
          // A failed pull stays silent while a cached timeline is on screen (user default #10, audit
          // R3, 2026-09-25; the shared toast table's DETAIL_REFRESH_FAILED row).
          if (result.querySucceeded !== false) {
            setNotice(detailPullToast(result.refreshed, hasUsableDetail));
          } else if (!hasUsableDetail) {
            setNotice(EXPRESS_TOAST_COPY.detailRefreshFailed);
          }
        }
      } catch (error) {
        if (generation === refreshGenerationRef.current) {
          const errorDetails = diagnosticErrorDetails(error);
          if (errorDetails.errorCategory === "removed") return;
          writeDiagnostic("detail.refresh.ui_failed", {
            trigger: forceManualRefresh
              ? "detail_pull"
              : props.refreshOnAppear || "product_image",
            ...errorDetails,
          }, "warning");
          if (props.shipment.identity.manuallyAdded && needsManualPhoneTail(error)) {
            setNotice(EXPRESS_TOAST_COPY.manualPhoneTailRequired);
          } else if (!displayTracks.length) {
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
    if (forceManualRefresh) pullInFlightRef.current = task;
    void task.then(() => {
      if (refreshInFlightRef.current === task) {
        refreshInFlightRef.current = null;
      }
      if (refreshAbortRef.current === controller) {
        refreshAbortRef.current = null;
      }
      if (pullInFlightRef.current === task) pullInFlightRef.current = null;
      if (generation === refreshGenerationRef.current && !pullInFlightRef.current && imageShipment) {
        void refreshProductImage(imageShipment, generation);
      }
    });
    return task;
  }

  function refreshProductImage(current: Shipment, generation: number): Promise<void> {
    if (productImageRequestRef.current) return productImageRequestRef.current;
    const controller = new AbortController();
    const task = Promise.resolve().then(async () => {
      if (controller.signal.aborted || generation !== refreshGenerationRef.current ||
          !shouldRequestDetailProductImage(current, loadState().bindings)) return;
      refreshAbortRef.current = controller;
      const result = await refreshShipmentById(current.identity.id, {
        trigger: "product_image", requestProductImage: true, signal: controller.signal,
      });
      if (controller.signal.aborted || generation !== refreshGenerationRef.current) return;
      setShipment((previous) => preferNewerShipment(previous, result.shipment));
      props.onStateChange?.(result.state, result.shipment);
    }).catch(error => {
      if (!controller.signal.aborted && generation === refreshGenerationRef.current) {
        writeDiagnostic("detail.image.failed", diagnosticErrorDetails(error), "warning");
      }
    }).finally(() => {
      if (productImageRequestRef.current === task) productImageRequestRef.current = null;
      if (refreshAbortRef.current === controller) refreshAbortRef.current = null;
    });
    productImageRequestRef.current = task;
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
      const sfBinding = externalAppName === "顺丰" ? loadState().bindings.find((binding) =>
        binding.source === shipment.identity.bindingSource && binding.phone === shipment.accountRecord?.phone) : undefined;
      let directURL = "";
      if (externalAppName === "快递100") {
        const currentState = loadState();
        const current = currentState.shipments.find((item) => item.identity.id === shipment.identity.id);
        directURL = shipment.identity.manuallyAdded
          ? current?.identity.manuallyAdded ? kuaidi100MiniProgramURL(displayWaybill(current)) : ""
          : accountKuaidi100URL(shipment, current, accountBindingRef.current,
            currentState.bindings.find((binding) => binding.source === current?.identity.bindingSource &&
              binding.phone === current?.accountRecord?.phone));
        if (!props.persistedShipment || !current || !directURL ||
          normalizeWaybill(displayWaybill(current)) !== normalizeWaybill(displayWaybill(shipment))) {
          setNotice("快递信息已更新，请重新打开详情");
          return;
        }
      }
      const targets = directURL
        ? [{ kind: "kuaidi100", url: directURL }]
        : await fetchAccountExternalAppRoutes(shipment, controller.signal);
      if (controller.signal.aborted) return;
      if (!targets.length) {
        setNotice(`来源暂未提供可用的${externalAppName}应用链接`);
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
          waybillTail: waybillSuffix(displayWaybill(shipment)),
          carrierCode: shipment.identity.courierCode,
          sourceProvider: shipment.identity.sourceProvider,
        }, opened ? "info" : "warning");
        if (opened || controller.signal.aborted) return;
        if (target.kind === "sf" && result === "open_failed") {
          setNotice("打开顺丰失败，请稍后重试");
          return;
        }
      }
      if (externalAppName === "顺丰" && sfBinding && targets.every((target) => target.kind === "sf")) {
        const currentState = loadState();
        const current = currentState.shipments.find((item) => item.identity.id === shipment.identity.id);
        const currentBinding = currentState.bindings.find((binding) =>
          binding.source === sfBinding.source && binding.phone === sfBinding.phone);
        const fallbackURL = shunfengKuaidi100FallbackURL(shipment, current);
        if (!fallbackURL || currentBinding?.boundAtMs !== sfBinding.boundAtMs ||
          !current || accountExternalAppName(current) !== "顺丰") {
          setNotice("快递信息已更新，请重新打开详情");
          return;
        }
        if (controller.signal.aborted) return;
        let opened = false;
        let result = "no_handler";
        try {
          opened = await Safari.openURL(fallbackURL);
          result = opened ? "opened" : "no_handler";
        } catch {
          result = "open_failed";
        }
        writeDiagnostic("detail.external.open", {
          stage: "kuaidi100", attempted: targets.length + 1, result,
          waybillTail: waybillSuffix(displayWaybill(current)),
          carrierCode: current.identity.courierCode,
          sourceProvider: current.identity.sourceProvider,
        }, opened ? "info" : "warning");
        if (!opened && !controller.signal.aborted)
          setNotice("暂时无法打开快递100小程序，请稍后重试");
        return;
      }
      setNotice(externalAppName === "菜鸟"
        ? "未能打开菜鸟、淘宝或支付宝，请确认已安装其中任一应用"
        : externalAppName === "快递100"
        ? "暂时无法打开快递100小程序，请稍后重试"
        : `无法打开${externalAppName}，请确认已安装该应用`);
    } catch {
      if (!controller.signal.aborted) setNotice(`打开${externalAppName}失败，请稍后重试`);
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
      refreshable={async () => { await Promise.all([refresh(true), refreshCloudMetadata()]); }}
      toast={transientToast(notice, setNotice)}
    >
      <Section>
        <HStack spacing={14} padding={{ vertical: 12 }} listRowSeparator="hidden">
          <ProductThumbnail
            shipment={shipment}
            cacheKey={shipment.identity.enhancedMode || shipment.identity.productImageURL
              ? productImageCacheKey(shipment.identity) : ""}
            courierCode={shipment.identity.courierCode}
            companyName={shipment.identity.companyName}
            accountOrder={Boolean(
              unprojectedAccountOrder(shipment),
            )}
            size={72}
            imageURL={shipment.identity.productImageURL}
          />
          <VStack alignment="leading" spacing={4} frame={{ maxWidth: "infinity" }}>
            <HStack alignment="center" spacing={6} contentShape="rect"
              onTapGesture={props.persistedShipment ? () => void editNote() : undefined}
              contextMenu={productNameMenu}>
              <Text
                font="body"
                fontWeight="bold"
                foregroundStyle={statusTextTint(presentationStatus.semantic)}
                lineLimit={1}
              >
                {statusText}
              </Text>
              {shipment.identity.sender === true ? (
                <SenderBadge semantic={presentationStatus.semantic} />
              ) : null}
            </HStack>
            {phoneTail ? (
              <HStack spacing={0}>
                <Text font="subheadline">手机尾号：</Text>
                <Text font="subheadline" monospacedDigit>{phoneTail}</Text>
              </HStack>
            ) : null}
            <HStack
              alignment="center"
              spacing={0}
              frame={{ maxWidth: "infinity", alignment: "leading" }}
            >
              <Text font="subheadline">{carrierDisplayName(shipment.identity.companyName)}：</Text>
              <Text font="subheadline" monospacedDigit lineLimit={1} minScaleFactor={0.65}
                allowsTightening={true} layoutPriority={1} contentShape="rect"
                onTapGesture={copyWaybill}>
                {waybill}
              </Text>
            </HStack>
            {hotline ? (
              <HStack spacing={0}>
                <Text font="subheadline">官方电话：</Text>
                <Button buttonStyle="plain" action={dial}>
                  <Text font="subheadline" foregroundStyle="systemBlue" monospacedDigit>
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

      {showParcelInfo ? (
        <Section>
          <VStack alignment="leading" spacing={4} padding={{ vertical: 8 }}
            frame={{ maxWidth: "infinity", alignment: "leading" }} contentShape="rect"
            onTapGesture={props.persistedShipment ? () => void editNote() : undefined}
            contextMenu={productNameMenu}>
            {platformFields.estimate ? (
              <Text font="subheadline" lineSpacing={3} fontWeight="medium" foregroundStyle="systemBlue">{platformFields.estimate}</Text>
            ) : null}
            {platformFields.title ? (
              <Text font="subheadline" lineSpacing={3} fixedSize={{ horizontal: false, vertical: true }}>
                {platformFields.title}
              </Text>
            ) : null}
            {note ? (
              <Text font="subheadline" lineSpacing={3} foregroundStyle="secondaryLabel"
                fixedSize={{ horizontal: false, vertical: true }}>{note}</Text>
            ) : null}
          </VStack>
        </Section>
      ) : null}

      {pickup ? (
        <Section>
          <VStack spacing={3} alignment="leading" frame={{ maxWidth: "infinity", alignment: "leading" }}
            padding={{ vertical: 6 }}>
            <Text font={15} fontWeight="semibold">取件码 {pickup.code}</Text>
            {pickup.location ? <Text font={13} foregroundStyle="secondaryLabel">{pickup.location}</Text> : null}
          </VStack>
        </Section>
      ) : null}

      <Section
        header={
          <HStack spacing={6}>
            {timelineSourceIcon ? (
              <Image image={timelineSourceIcon}
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
              : "下拉刷新物流轨迹。"}
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
                  font="subheadline"
                  lineSpacing={3}
                  foregroundStyle={index === 0 ? "label" : "secondaryLabel"}
                  frame={{ maxWidth: "infinity", alignment: "leading" }}
                  styledText={trackPhoneText(trackDisplayDetail(detailTimeline.provider, track), (phone) => { void dialPhone(phone); })}
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
            <Text font="subheadline" foregroundStyle="secondaryLabel">
              {loadingManualDetail ? MANUAL_QUERY_IN_FLIGHT_TEXT : "暂无物流信息"}
            </Text>
          </VStack>
        )}
      </Section>
    </List>
  );
}
