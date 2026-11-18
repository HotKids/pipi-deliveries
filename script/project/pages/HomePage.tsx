import {
  Button,
  Capsule,
  HStack,
  Image,
  List,
  Navigation,
  NavigationStack,
  ProgressView,
  ScrollView,
  Section,
  Text,
  TextField,
  VStack,
  ZStack,
  useEffect,
  useMemo,
  useObservable,
  useRef,
  useState,
} from "scripting";
import type { AppState, RefreshSummary, Shipment, StatusSemantic } from "../models";
import { ShipmentRow } from "../components/ShipmentRow";
import { EmptyDeliveryStateGroup } from "../components/EmptyDeliveryVehicle";
import {
  commitManualShipmentPreview,
  queryManualShipmentPreview,
  refreshAllShipments,
  refreshAllShipmentsForPull,
  subscribeRefreshState,
} from "../services/sync";
import { saveRecognizedShipmentPickup, stateLoadFailure } from "../services/storage";
import type { ParcelLookup } from "../services/parcel-code-ocr";
import { attachedProjectedOrders } from "../services/waybill-ownership";
import { DetailPage } from "./DetailPage";
import {
  consumeShipmentNavigationTarget,
  manualPreviewNavigationTarget,
  persistedShipmentNavigationTarget,
  promotedPendingShipmentNavigationTarget,
  selectedNavigationShipment,
  shipmentNavigationTargetId,
  type ShipmentNavigationTarget,
} from "../services/ui-state";
import {
  performShipmentCompletion,
  performShipmentDeletion,
} from "../services/shipment-actions";
import {
  errorMessage,
  isManualQueryValidationMessage,
  manualQueryFailureToast,
  refreshSummaryToast,
  transientToast,
} from "../services/ui-feedback";
import {
  ManualCarrierDetectionCoordinator,
  storedCarrierDetection,
  type ManualCarrierDetection,
} from "../services/manual-query";

/**
 * The floor all three clients share (Lite ExpressListActivity, Pipi add_express_sheet). Raising it
 * on one client alone would mean a 6-to-9-character waybill fills the chip on two clients and not
 * on the third, which is the divergence AGENTS §11 forbids; the debounce below is a local input
 * detail and carries no cross-client semantics.
 */
const CARRIER_DETECTION_MIN_LENGTH = 6;
const CARRIER_DETECTION_DEBOUNCE_MS = 600;
import { manualPreviewNeedsDetailRefresh } from "../services/manual-preview";
import { normalizeWaybill, shipmentPresentationStatus } from "../services/status";
import {
  displayWaybill,
  needsDetailEntryQuery,
  unprojectedAccountOrder,
} from "../services/shipment-policy";
import { EXPRESS_TOAST_COPY } from "../services/express-toast-copy";
import {
  gatewayAccessKeyRejected,
  subscribeGatewayAccessKeyRejected,
} from "../services/credentials";

const shipmentFilters = {
  all: "全部",
  transit: "在途",
  pickup: "待取",
  danger: "异常",
} as const;
type ShipmentFilter = keyof typeof shipmentFilters;

function shipmentFilter(semantic: StatusSemantic): Exclude<ShipmentFilter, "all"> | undefined {
  switch (semantic) {
    case "ORDERED":
    case "SHIPPED":
    case "PICKED":
    case "TRANSIT":
    case "DELIVERY":
      return "transit";
    case "WAITING_PICKUP": return "pickup";
    case "DANGER": return "danger";
    default: return undefined;
  }
}

export function HomePage(props: {
  state: AppState;
  shipments: readonly Shipment[];
  autoFocusSearch: boolean;
  initialShipmentId: string;
  navigationRequestGeneration: number;
  shortcutLookup?: ParcelLookup;
  onShortcutHandled: (generation: number) => void;
  onStateChange: (state: AppState) => void;
  onListPull?: () => void;
  platformNotice?: Readonly<{ text: string }>;
}) {
  const dismiss = Navigation.useDismiss();
  const [refreshing, setRefreshing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  /** E1: a pull's background completion applies its result only while this page is mounted. */
  const mountedRef = useRef(true);
  const [completing, setCompleting] = useState(false);
  const completingRef = useRef(false);
  const [notice, setNotice] = useState("");
  const [selectedFilter, setFilter] = useState<ShipmentFilter>("all");
  const searchPresented = useObservable(props.autoFocusSearch && !props.initialShipmentId);
  const handledNavigationRef = useRef<number | undefined>(undefined);
  const [accessKeyRejected, setAccessKeyRejected] = useState(gatewayAccessKeyRejected);
  const [accessKeyNoticeDismissed, setAccessKeyNoticeDismissed] = useState(false);
  const [shipmentNavigationTarget, setShipmentNavigationTargetState] = useState<
    ShipmentNavigationTarget | null
  >(() => props.initialShipmentId && props.state.shipments.some(
    (shipment) => shipment.identity.id === props.initialShipmentId,
  ) ? persistedShipmentNavigationTarget(props.initialShipmentId) : null);
  const shipmentNavigationTargetRef = useRef(shipmentNavigationTarget);
  const shipments = props.shipments;
  const groups = useMemo(() => {
    const buckets = { all: shipments, transit: [] as Shipment[], pickup: [] as Shipment[], danger: [] as Shipment[] };
    for (const shipment of shipments) {
      const bucket = shipmentFilter(shipmentPresentationStatus(shipment).semantic);
      if (bucket) buckets[bucket].push(shipment);
    }
    return buckets;
  }, [shipments]);
  const visibleFilters = (Object.keys(shipmentFilters) as ShipmentFilter[])
    .filter((key) => key === "all" || groups[key].length > 0);
  const filter = visibleFilters.includes(selectedFilter) ? selectedFilter : "all";
  const shownShipments = groups[filter];
  const selected = selectedNavigationShipment(
    props.state,
    shipmentNavigationTarget,
  );
  const selectedAttachedOrders = useMemo(
    () => (selected ? attachedProjectedOrders(props.state.shipments, selected) : undefined),
    [props.state.shipments, selected],
  );
  const manualPreview = shipmentNavigationTarget?.kind === "manualPreview"
    ? shipmentNavigationTarget.preview
    : null;

  function setShipmentNavigationTarget(
    target: ShipmentNavigationTarget | null,
  ) {
    shipmentNavigationTargetRef.current = target;
    setShipmentNavigationTargetState(target);
    if (target) searchPresented.setValue(false);
  }

  function applyInteractiveRefreshSummary(summary: RefreshSummary) {
    const promotedTarget = promotedPendingShipmentNavigationTarget(
      summary,
      shipmentNavigationTargetRef.current,
    );
    props.onStateChange(summary.state);
    if (promotedTarget) setShipmentNavigationTarget(promotedTarget);
  }

  useEffect(() => {
    return subscribeGatewayAccessKeyRejected(setAccessKeyRejected);
  }, []);

  useEffect(() => {
    if (props.platformNotice) setNotice(props.platformNotice.text);
  }, [props.platformNotice]);

  useEffect(() => {
    let active = true;
    mountedRef.current = true;
    const unsubscribe = subscribeRefreshState(props.onStateChange);
    // 所有副本都迁移失败时不是空库，而是读取失败（2026-09-06 静态审查②）：进页先说一声。
    if (stateLoadFailure()) setNotice(EXPRESS_TOAST_COPY.stateLoadFailed);
    void refreshAllShipments()
      .then((summary) => {
        if (active) props.onStateChange(summary.state);
      })
      .catch(() => {
        /* cached data remains available when the launch refresh fails */
      });
    return () => {
      active = false;
      mountedRef.current = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    if (selectedFilter !== filter) setFilter(filter);
  }, [selectedFilter, filter]);

  useEffect(() => {
    const generation = props.navigationRequestGeneration;
    if (handledNavigationRef.current === generation) return;
    handledNavigationRef.current = generation;
    if (props.initialShipmentId && props.state.shipments.some(
      (shipment) => shipment.identity.id === props.initialShipmentId,
    )) {
      setShipmentNavigationTarget(persistedShipmentNavigationTarget(props.initialShipmentId));
    } else if (props.autoFocusSearch) {
      setShipmentNavigationTarget(null);
      searchPresented.setValue(true);
    }
  }, [props.navigationRequestGeneration]);

  /** E1: the rest of a pull's refresh lands after its account phase was shown. */
  function followPullCompletion(completion: Promise<RefreshSummary>) {
    void completion
      .then((finished) => { if (mountedRef.current) applyInteractiveRefreshSummary(finished); })
      .catch(() => { /* the account part is already shown; a later failure keeps the cached list */ });
  }

  async function refresh() {
    if (refreshing) return;
    setRefreshing(true);
    setNotice("");
    try {
      // E1 (owner 2026-11-10): the spinner ends once the account phase is stored; the per-shipment work
      // goes on in the same refresh and reaches this page through subscribeRefreshState.
      const { summary, completion } = await refreshAllShipmentsForPull(undefined, {
        accountSourceFollowup: true,
      });
      applyInteractiveRefreshSummary(summary);
      props.onListPull?.();
      setNotice(refreshSummaryToast(summary));
      if (summary.continuing) followPullCompletion(completion);
    } catch (error) {
      // One gesture, one outcome: refreshAllShipments resolves with failures on the line above
      // and rejects here, so both branches have to say 刷新失败 rather than 查询失败.
      setNotice(EXPRESS_TOAST_COPY.refreshFailed);
    } finally {
      setRefreshing(false);
    }
  }

  // The same shape PhoneManagerPage.remove uses, down to the in-flight guard and the catch:
  // `Dialog` is a host global (nothing in this project imports it), rows must sit inside a
  // Section for the list to keep row identity, and an unguarded throw from a swipe action ends
  // the whole script session instead of showing a toast (index.tsx:127-129).
  async function confirmDelete(shipment: Shipment): Promise<void> {
    if (deletingRef.current) return;
    deletingRef.current = true;
    setDeleting(true);
    setNotice("");
    try {
      const confirmed = await Dialog.confirm({
        title: "要删除此快递吗？",
        message: "删除后，该快递及其本地物流轨迹将一并移除。",
        cancelLabel: "取消",
        confirmLabel: "删除",
      });
      if (!confirmed) return;
      remove(shipment.identity.id);
    } catch (error) {
      // 删除这一个手势只有两种结果：该快递已删除 / 删除失败（AGENTS §11 统一表）。
      setNotice(EXPRESS_TOAST_COPY.deleteFailed);
    } finally {
      deletingRef.current = false;
      setDeleting(false);
    }
  }

  function remove(id: string) {
    setNotice("");
    const result = performShipmentDeletion(id);
    if (!result.ok) {
      setNotice(EXPRESS_TOAST_COPY.deleteFailed);
      return;
    }
    props.onStateChange(result.state);
    setNotice(EXPRESS_TOAST_COPY.deleted);
    if (shipmentNavigationTargetId(shipmentNavigationTarget) === id) {
      setShipmentNavigationTarget(null);
    }
  }

  // 与 confirmDelete 同一套：行只声明手势，确认在页面，任何抛出都收进 toast。签收之后这一票
  // 就被 forcedCompletedAtMs 闩住，后续自动同步不再改它；想放开只能删掉，下一轮同步会带回来。
  async function confirmComplete(shipment: Shipment): Promise<void> {
    if (completingRef.current) return;
    completingRef.current = true;
    setCompleting(true);
    setNotice("");
    try {
      const confirmed = await Dialog.confirm({
        title: "要标记为已签收吗？",
        message: "标记后该快递状态不再随自动同步更新，删除后下一轮同步可重新带回。",
        cancelLabel: "取消",
        confirmLabel: "签收",
      });
      if (!confirmed) return;
      complete(shipment.identity.id);
    } catch (error) {
      setNotice(EXPRESS_TOAST_COPY.signFailed);
    } finally {
      completingRef.current = false;
      setCompleting(false);
    }
  }

  function complete(id: string) {
    setNotice("");
    const result = performShipmentCompletion(id);
    if (!result.ok) {
      setNotice(EXPRESS_TOAST_COPY.signFailed);
      return;
    }
    props.onStateChange(result.state);
    setNotice(EXPRESS_TOAST_COPY.signed);
  }

  function openShipment(shipment: Shipment) {
    setShipmentNavigationTarget(
      persistedShipmentNavigationTarget(shipment.identity.id),
    );
  }

  const shortcutSearchProps = {
    shortcutLookup: props.shortcutLookup,
    shortcutGeneration: props.navigationRequestGeneration,
    onShortcutHandled: props.onShortcutHandled,
  };

  return (
    <NavigationStack>
      <VStack
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
        navigationTitle="快递"
        navigationBarTitleDisplayMode="large"
        toast={searchPresented.value ? undefined : transientToast(notice, setNotice)}
        toolbar={{
          topBarLeading: (
            <Button buttonStyle="plain" action={() => dismiss()}>
              <Image
                systemName="chevron.left"
                font={17}
                frame={{ width: 44, height: 44 }}
              />
            </Button>
          ),
          topBarTrailing: (
            <Button title="查询快递" systemImage="magnifyingglass" labelStyle="iconOnly"
              buttonStyle="plain" frame={{ width: 44, height: 44 }} action={() => searchPresented.setValue(true)} />
          ),
        }}
        sheet={{
          isPresented: searchPresented,
          content: (
            <NavigationStack
              background="systemGroupedBackground"
              toolbarBackgroundVisibility={{ visibility: "hidden", bars: ["navigationBar"] }}
            >
              <ScrollView navigationTitle="查快递" navigationBarTitleDisplayMode="inline" scrollIndicator="never"
                frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
                background="systemGroupedBackground"
                toolbar={{
                  cancellationAction: (
                    <Button title="关闭" systemImage="xmark" labelStyle="iconOnly"
                      action={() => searchPresented.setValue(false)} />
                  ),
                }}
                toast={transientToast(notice, setNotice)}
              >
                <HomeSearchBar
                  state={props.state}
                  shipments={shipments}
                  autoFocusSearch={props.autoFocusSearch}
                  {...shortcutSearchProps}
                  onStateChange={props.onStateChange}
                  setNotice={setNotice}
                  openShipment={openShipment}
                  setShipmentNavigationTarget={setShipmentNavigationTarget}
                />
              </ScrollView>
            </NavigationStack>
          ),
        }}
        navigationDestination={{
          isPresented: Boolean(selected),
          onChanged: (presented) => {
            if (presented) return;
            const consumed = consumeShipmentNavigationTarget(
              shipmentNavigationTargetRef.current,
            );
            setShipmentNavigationTarget(consumed.nextTarget);
          },
          content: selected ? (
            <DetailPage
              key={selected.identity.id}
              shipment={selected}
              persistedShipment={props.state.shipments.some(
                (shipment) => shipment.identity.id === selected.identity.id,
              )}
              accountBinding={props.state.bindings.find((binding) =>
                binding.source === selected.identity.bindingSource && binding.phone === selected.accountRecord?.phone)}
              attachedOrders={selectedAttachedOrders}
              manualPreview={manualPreview}
              refreshOnAppear={manualPreview
                ? manualPreviewNeedsDetailRefresh(selected)
                  ? "manual_submit"
                  : false
                : unprojectedAccountOrder(selected)
                  ? "detail_open"
                  : needsDetailEntryQuery(selected) ? "detail_open" : false}
              onStateChange={(next) => {
                props.onStateChange(next);
              }}
            />
          ) : <Text>快递详情</Text>,
        }}
      >
        {accessKeyRejected && !accessKeyNoticeDismissed ? (
          <VStack padding={{ horizontal: 20, vertical: 8 }}>
            <HStack
              spacing={0}
              padding={{ leading: 16, trailing: 12, vertical: 12 }}
              background="secondarySystemBackground"
              clipShape={{ type: "rect", cornerRadius: 20, style: "continuous" }}
            >
              <Text
                font={14}
                foregroundStyle="secondaryLabel"
                frame={{ maxWidth: "infinity", alignment: "leading" }}
              >
                Access Key 已失效，请通过 TG Bot 重新获取。
              </Text>
              <Button
                role="close"
                buttonStyle="plain"
                action={() => setAccessKeyNoticeDismissed(true)}
              >
                <Image
                  systemName="xmark"
                  font={24}
                  foregroundStyle="secondaryLabel"
                  frame={{ width: 48, height: 48 }}
                  contentShape="rect"
                />
              </Button>
            </HStack>
          </VStack>
        ) : null}
        {visibleFilters.length > 1 ? (
          <ZStack padding={{ horizontal: 20, vertical: 2 }}>
            <Capsule fill="thinMaterial" stroke={{ shapeStyle: "separator", strokeStyle: { lineWidth: 0.5 } }}
              frame={{ height: 32 }} />
            <HStack spacing={0} padding={{ horizontal: 3 }}>
              {visibleFilters.map((key) => {
                const selected = filter === key;
                return (
                  <Button key={key} buttonStyle="plain" action={() => setFilter(key)}>
                    <VStack frame={{ maxWidth: "infinity", minHeight: 44 }} contentShape="rect">
                      <HStack
                        spacing={4}
                        frame={{ maxWidth: "infinity", minHeight: 26 }}
                        background={{ style: selected ? "secondarySystemFill" : "clear", shape: "capsule" }}
                      >
                        <Text font={14} fontWeight={selected ? "semibold" : "medium"} lineLimit={1} minScaleFactor={0.8}>
                          {shipmentFilters[key]}
                        </Text>
                        <Text font={11} fontWeight="semibold" monospacedDigit foregroundStyle="secondaryLabel"
                          lineLimit={1} padding={{ horizontal: 4 }} frame={{ minWidth: 16, minHeight: 16 }}
                          background={{ style: "systemFill", shape: "capsule" }}>
                          {groups[key].length}
                        </Text>
                      </HStack>
                    </VStack>
                  </Button>
                );
              })}
            </HStack>
          </ZStack>
        ) : null}
        {shipments.length ? (
          <List listStyle="plain" refreshable={refresh}>
            <Section listSectionSeparator={visibleFilters.length === 1
              ? { visibility: "hidden", edges: "top" } : undefined}>
              {shownShipments.map((shipment) => (
                <ShipmentRow
                  key={shipment.identity.id}
                  shipment={shipment}
                  onOpen={() => openShipment(shipment)}
                  onDelete={() => void confirmDelete(shipment)}
                  onComplete={() => void confirmComplete(shipment)}
                  deleteDisabled={deleting}
                  completeDisabled={completing}
                />
              ))}
            </Section>
            <VStack
              spacing={8}
              padding={{ bottom: 12 }}
              frame={{ maxWidth: "infinity" }}
              listRowSeparator="hidden"
            >
              <Text
                font={12}
                foregroundStyle="tertiaryLabel"
                frame={{ maxWidth: "infinity", alignment: "center" }}
              >
                只显示 14 天内的快递
              </Text>
            </VStack>
          </List>
        ) : (
          <VStack
            spacing={0}
            frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
          >
            <List
              listStyle="plain"
              refreshable={refresh}
              frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
              overlay={{
                alignment: "center",
                content: (
                  <EmptyDeliveryStateGroup
                    vehicleSize={81.6}
                    spacing={6}
                    labelFont={24}
                  />
                ),
              }}
            />
          </VStack>
        )}
      </VStack>
    </NavigationStack>
  );
}

function HomeSearchBar(props: {
  state: AppState;
  shipments: readonly Shipment[];
  autoFocusSearch: boolean;
  shortcutLookup?: ParcelLookup;
  shortcutGeneration: number;
  onShortcutHandled: (generation: number) => void;
  onStateChange: (state: AppState) => void;
  setNotice: (notice: string) => void;
  openShipment: (shipment: Shipment) => void;
  setShipmentNavigationTarget: (target: ShipmentNavigationTarget | null) => void;
}) {
  const { setNotice, openShipment, setShipmentNavigationTarget } = props;
  const [waybill, setWaybill] = useState(props.shortcutLookup?.waybill ?? "");
  const [phoneTail, setPhoneTail] = useState("");
  const [needsPhoneTail, setNeedsPhoneTail] = useState(false);
  const [detectedCarrier, setDetectedCarrier] = useState<
    ManualCarrierDetection | null
  >(null);
  const [querying, setQuerying] = useState(false);
  const [validationNotice, setValidationNotice] = useState("");
  const waybillRef = useRef(props.shortcutLookup?.waybill ?? "");
  const shortcutGenerationRef = useRef(props.shortcutGeneration);
  const phoneTailRef = useRef("");
  const queryingRef = useRef(false);
  const carrierDetectionSequenceRef = useRef(0);
  const carrierDetectionTimerRef = useRef<number | null>(null);
  const carrierDetectionCoordinatorRef = useRef<
    ManualCarrierDetectionCoordinator | null
  >(null);
  if (!carrierDetectionCoordinatorRef.current) {
    carrierDetectionCoordinatorRef.current = new ManualCarrierDetectionCoordinator();
  }
  const phoneTailValidation = validationNotice.includes("手机尾号");

  useEffect(() => {
    return () => {
      carrierDetectionSequenceRef.current += 1;
      shortcutGenerationRef.current += 1;
      if (carrierDetectionTimerRef.current != null) {
        clearTimeout(carrierDetectionTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!props.shortcutLookup) return;
    shortcutGenerationRef.current = props.shortcutGeneration;
    carrierDetectionSequenceRef.current += 1;
    if (carrierDetectionTimerRef.current != null) {
      clearTimeout(carrierDetectionTimerRef.current);
      carrierDetectionTimerRef.current = null;
    }
    waybillRef.current = props.shortcutLookup.waybill;
    phoneTailRef.current = "";
    setWaybill(props.shortcutLookup.waybill);
    setPhoneTail("");
    setNeedsPhoneTail(false);
    setDetectedCarrier(null);
    setValidationNotice("");
  }, [props.shortcutGeneration, props.shortcutLookup]);

  function scheduleCarrierDetection(value: string) {
    const normalized = normalizeWaybill(value);
    const sequence = carrierDetectionSequenceRef.current + 1;
    carrierDetectionSequenceRef.current = sequence;
    if (carrierDetectionTimerRef.current != null) {
      clearTimeout(carrierDetectionTimerRef.current);
      carrierDetectionTimerRef.current = null;
    }
    // A waybill already in the list answers for itself, with no request and no cache to consult.
    const stored = storedCarrierDetection(normalized, props.state.shipments);
    setDetectedCarrier(stored);
    if (stored) return;
    // Recognition is a network question, so it waits for a number that looks finished rather than
    // firing on every prefix; a 16-digit waybill used to spend ten recognitions on its way in.
    if (normalized.length < CARRIER_DETECTION_MIN_LENGTH) return;

    carrierDetectionTimerRef.current = setTimeout(() => {
      carrierDetectionTimerRef.current = null;
      void carrierDetectionCoordinatorRef.current!.resolve(normalized)
        .then((carrier) => {
          if (
            sequence === carrierDetectionSequenceRef.current &&
            normalizeWaybill(waybillRef.current) === normalized
          ) {
            setDetectedCarrier(carrier);
          }
        })
        .catch(() => {
          if (sequence === carrierDetectionSequenceRef.current) {
            setDetectedCarrier(null);
          }
        });
    }, CARRIER_DETECTION_DEBOUNCE_MS);
  }

  function clearQueryInputs() {
    carrierDetectionSequenceRef.current += 1;
    if (carrierDetectionTimerRef.current != null) {
      clearTimeout(carrierDetectionTimerRef.current);
      carrierDetectionTimerRef.current = null;
    }
    waybillRef.current = "";
    phoneTailRef.current = "";
    setWaybill("");
    setPhoneTail("");
    setNeedsPhoneTail(false);
    setDetectedCarrier(null);
    Keyboard.hide();
  }

  async function query() {
    if (queryingRef.current) return;
    const submittedWaybill = waybillRef.current;
    const shortcutGeneration = shortcutGenerationRef.current;
    const submittedPhoneTail = phoneTailRef.current;
    const submittedNormalized = normalizeWaybill(submittedWaybill);
    const lookup = props.shortcutLookup && normalizeWaybill(props.shortcutLookup.waybill) === submittedNormalized
      ? props.shortcutLookup : undefined;
    if (submittedNormalized.length < 6) {
      setValidationNotice("请输入有效的快递单号");
      return;
    }
    // Checked before carrier detection and before any provider round: a waybill the list already
    // tracks must not spend a recognition call, a provider query or a second row.
    const alreadyListed = props.shipments.find(
      (shipment) => normalizeWaybill(displayWaybill(shipment)) === submittedNormalized,
    );
    if (alreadyListed) {
      if (lookup?.pickup) {
        try {
          props.onStateChange(saveRecognizedShipmentPickup(alreadyListed, lookup));
        } catch {
          setNotice("无法保存取件码，请重试。");
          return;
        }
      }
      setValidationNotice("");
      setNotice(EXPRESS_TOAST_COPY.alreadyInList);
      // 用户定 2026-09-05：提示「已在列表」的同时打开那一票的详情（三端同）。
      openShipment(alreadyListed);
      if (props.shortcutLookup) {
        props.onShortcutHandled(shortcutGeneration);
        clearQueryInputs();
      }
      return;
    }
    // 尾号输入框已经在页面上（承运商要尾号）却还没填满四位时，先内联提示，不要先弹「正在查询」——
    // 用户 2026-09-08 报：顺丰的单号识别出来了、尾号还空着，点查询弹的是「正在查询，请稍候」。
    if ((needsPhoneTail || detectedCarrier?.requiresPhoneTail)
      && submittedPhoneTail.length !== 4) {
      setNeedsPhoneTail(true);
      // 一个字都没填就是「请输入手机尾号」（与 Lite 的尾号对话框标题同字，用户定 2026-09-08）；
      // 填了但不满四位才提示位数。
      setValidationNotice(
        submittedPhoneTail ? "请输入 4 位手机尾号" : "请输入手机尾号",
      );
      return;
    }
    queryingRef.current = true;
    setQuerying(true);
    carrierDetectionSequenceRef.current += 1;
    if (carrierDetectionTimerRef.current != null) {
      clearTimeout(carrierDetectionTimerRef.current);
      carrierDetectionTimerRef.current = null;
    }
    setDetectedCarrier(null);
    // 统一 toast（AGENTS §11）：提交即短弹一次「正在查询」，不再常驻到查完。
    setNotice(EXPRESS_TOAST_COPY.manualQuerying);
    setValidationNotice("");
    try {
      let submittedCarrier: ManualCarrierDetection | null = null;
      try {
        submittedCarrier = await carrierDetectionCoordinatorRef.current!.resolve(
          submittedWaybill,
        );
      } catch {
        submittedCarrier = null;
      }
      if (shortcutGeneration !== shortcutGenerationRef.current) return;
      if (submittedCarrier) setDetectedCarrier(submittedCarrier);
      if (
        (submittedCarrier?.requiresPhoneTail || needsPhoneTail) &&
        submittedPhoneTail.length !== 4
      ) {
        setNeedsPhoneTail(true);
        setValidationNotice(
          submittedPhoneTail ? "请输入 4 位手机尾号" : "请输入手机尾号",
        );
        return;
      }
      const preview = await queryManualShipmentPreview({
        waybill: submittedWaybill,
        phoneTail: submittedPhoneTail,
        presentation: submittedCarrier,
      });
      const committed = commitManualShipmentPreview(preview, Date.now(), lookup);
      props.onStateChange(committed);
      if (shortcutGeneration !== shortcutGenerationRef.current) return;
      const resolvedLookup = !lookup?.pickup || committed.shipments.some((shipment) =>
        displayWaybill(shipment) === submittedNormalized);
      if (resolvedLookup) props.onShortcutHandled(shortcutGeneration);
      setShipmentNavigationTarget(
        manualPreviewNavigationTarget(preview, committed),
      );
      if (resolvedLookup) clearQueryInputs();
    } catch (error) {
      if (shortcutGeneration !== shortcutGenerationRef.current) return;
      // 校验类文案内联显示；其余一律走统一的失败 / 超时 toast，上游文案不外露。
      const value = errorMessage(error, "");
      if (isManualQueryValidationMessage(value)) {
        setValidationNotice(value);
      } else {
        setNotice(manualQueryFailureToast(error));
      }
      if (value.includes("手机尾号")) setNeedsPhoneTail(true);
      scheduleCarrierDetection(submittedWaybill);
    } finally {
      queryingRef.current = false;
      setQuerying(false);
    }
  }

  return (
    <VStack
      spacing={8}
      alignment="leading"
      padding={{ horizontal: 16, top: 6, bottom: 40 }}
    >
      <HStack
        spacing={8}
        padding={{ horizontal: 16, vertical: 13 }}
        frame={{ maxWidth: "infinity" }}
        background={{ style: "tertiarySystemFill", shape: "capsule" }}
      >
        <Image
          systemName="magnifyingglass"
          font={18}
          foregroundStyle="label"
        />
        <TextField
          title="查询快递单号"
          value={waybill}
          onChanged={(value) => {
            if (props.shortcutLookup) props.onShortcutHandled(shortcutGenerationRef.current);
            waybillRef.current = value;
            setWaybill(value);
            phoneTailRef.current = "";
            setPhoneTail("");
            setNeedsPhoneTail(false);
            setValidationNotice("");
            scheduleCarrierDetection(value);
          }}
          prompt="搜索运单号"
          autofocus={props.autoFocusSearch}
          textContentType="shipmentTrackingNumber"
          submitLabel="search"
          onSubmit={{
            triggers: "text",
            action: () => {
              void query();
            },
          }}
          frame={{ maxWidth: "infinity" }}
        />
        {detectedCarrier ? (
          <Button
            action={() => {
              void query();
            }}
            buttonStyle="plain"
          >
            <Text
              font={14}
              foregroundStyle="accentColor"
              lineLimit={1}
              minScaleFactor={0.75}
              frame={{ minWidth: 48, height: 44, alignment: "trailing" }}
              contentShape="rect"
            >
              {detectedCarrier.companyName}
            </Text>
          </Button>
        ) : querying ? (
          <ProgressView progressViewStyle="circular" />
        ) : props.shortcutLookup ? (
          <Button title="查询" buttonStyle="plain" action={() => { void query(); }} />
        ) : null}
      </HStack>
      {needsPhoneTail ? (
        <HStack
          spacing={9}
          padding={{ horizontal: 14 }}
          frame={{ minHeight: 52, maxWidth: "infinity" }}
          background="tertiarySystemFill"
          clipShape={{ type: "rect", cornerRadius: 24, style: "continuous" }}
        >
          <Image
            systemName="phone"
            foregroundStyle={phoneTailValidation ? "systemRed" : "secondaryLabel"}
          />
          <VStack
            alignment="leading"
            spacing={1}
            frame={{ maxWidth: "infinity", alignment: "leading" }}
          >
            <TextField
              title="手机尾号"
              value={phoneTail}
              onChanged={(value) => {
                const next = value.replace(/\D/g, "").slice(0, 4);
                phoneTailRef.current = next;
                setPhoneTail(next);
                setValidationNotice("");
              }}
              prompt={phoneTailValidation
                ? validationNotice
                : "请输入 4 位手机尾号"}
              keyboardType="numberPad"
              submitLabel="search"
              onSubmit={{
                triggers: "text",
                action: () => {
                  void query();
                },
              }}
              frame={{ maxWidth: "infinity" }}
            />
            {phoneTailValidation && phoneTail ? (
              <Text font={11} foregroundStyle="systemRed" lineLimit={1}>
                {validationNotice}
              </Text>
            ) : null}
          </VStack>
          <Button
            title={querying ? "查询中…" : "查询"}
            buttonStyle="plain"
            action={() => {
              void query();
            }}
          />
        </HStack>
      ) : null}
      {validationNotice && !phoneTailValidation ? (
        <Text font={12} foregroundStyle="systemRed">{validationNotice}</Text>
      ) : null}
    </VStack>
  );
}
