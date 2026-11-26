import { INPUT_ROW_HEIGHT, INPUT_ROW_ICON_GAP, INPUT_ROW_ICON_SIZE, INPUT_ROW_INSET } from "../components/input-metrics";
import {
  Button,
  Capsule,
  ForEach,
  GeometryReader,
  HStack,
  Image,
  Navigation,
  NavigationStack,
  ProgressView,
  Rectangle,
  ScrollView,
  Section,
  Text,
  TextField,
  VStack,
  ZStack,
  AbortController,
  useCallback,
  useEffect,
  useMemo,
  useObservable,
  useRef,
  useState,
} from "scripting";
import type { AppState, RefreshSummary, Shipment, StatusSemantic } from "../models";
import { ShipmentRow } from "../components/ShipmentRow";
import { EmptyTabState } from "../components/EmptyDeliveryVehicle";
import { ROOT_PAGE_MARGIN, RootTabList } from "../components/RootPageHeader";
import { TAB_FAB_PADDING, TAB_FAB_SCROLL_INSET, TabFloatingActionButton } from "../components/TabFloatingActionButton";
import { synchronizeParcelCloudRecords } from "../services/parcel-cloud-sync";
import {
  commitManualShipmentPreview,
  queryManualShipmentPreview,
  refreshAllShipmentsForPull,
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
  withWatchPullOutcome,
  type WatchPullOutcome,
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
import { normalizeWaybill, shipmentPresentationStatus, waybillSuffix } from "../services/status";
import { beginDiagnosticOperation, diagnosticErrorDetails } from "../services/logger";
import {
  displayWaybill,
  needsDetailEntryQuery,
  unprojectedAccountOrder,
} from "../services/shipment-policy";
import { EXPRESS_TOAST_COPY } from "../services/express-toast-copy";
import { internationalShipment, watchDetailOpenRefreshes } from "../services/international-records";
import {
  accessKeyReminder,
  subscribeAccessKeyReminder,
  type AccessKeyReminder,
} from "../services/access-key-reminder";

/**
 * Home's Access Key notices. The conflict text repeats the Settings authorization notice; `missing` and
 * `conflict` open Settings, where the key is entered (owner decision, 2026-11-21: 首页提醒).
 */
const ACCESS_KEY_NOTICE_COPY: Record<AccessKeyReminder, string> = {
  rejected: "Access Key 已失效，请通过 TG Bot 重新获取。",
  missing: "Access Key 未设置，请重新填写。",
  conflict: "检测到本地授权记录不一致，请重新保存 Access Key。",
};

const shipmentFilters = {
  all: "全部",
  transit: "在途",
  pickup: "待取",
  danger: "异常",
} as const;
type ShipmentFilter = keyof typeof shipmentFilters;

const FILTER_SEGMENT_INSET = 3;
const FILTER_ROW_HEIGHT = 44;
const FILTER_SLIDE_SECONDS = 0.24;

function ShipmentFilterBar({ visibleFilters, filter, groups, onSelect }: {
  visibleFilters: readonly ShipmentFilter[];
  filter: ShipmentFilter;
  groups: Record<ShipmentFilter, readonly unknown[]>;
  onSelect: (filter: ShipmentFilter) => void;
}) {
  return (
    <VStack transition={Transition.opacity()}
      listRowInsets={{ top: 2, bottom: 2, leading: ROOT_PAGE_MARGIN, trailing: ROOT_PAGE_MARGIN }}
      listRowBackground={<Rectangle fill="clear" />} listRowSeparator="hidden">
      <GeometryReader frame={{ height: FILTER_ROW_HEIGHT }}>
        {({ size }) => {
          const segmentWidth = Math.max(0, size.width - 2 * FILTER_SEGMENT_INSET) / visibleFilters.length;
          const selectedOffset = FILTER_SEGMENT_INSET + visibleFilters.indexOf(filter) * segmentWidth;
          const layoutKey = `${filter}:${visibleFilters.join(",")}`;
          return (
            <ZStack alignment="leading" frame={{ width: size.width, height: FILTER_ROW_HEIGHT }}
              animation={{ animation: Animation.smooth({ duration: FILTER_SLIDE_SECONDS }), value: layoutKey }}>
              <Capsule fill="tertiarySystemFill"
                frame={{ height: 32 }} allowsHitTesting={false} />
              {segmentWidth > 0 ? (
                <Capsule fill="systemBackground" frame={{ width: segmentWidth, height: 26 }}
                  shadow={{ color: "rgba(0,0,0,0.08)", radius: 2, x: 0, y: 1 }}
                  offset={{ x: selectedOffset, y: 0 }} allowsHitTesting={false} />
              ) : null}
              <HStack spacing={0} padding={{ horizontal: FILTER_SEGMENT_INSET }}>
                {visibleFilters.map((key) => (
                  <Button key={key} buttonStyle="plain" action={() => onSelect(key)} transition={Transition.opacity()}
                    {...{ accessibilityAddTraits: key === filter ? "isSelected" as const : undefined }}>
                    <HStack spacing={4} frame={{ width: segmentWidth, height: FILTER_ROW_HEIGHT }} contentShape="rect">
                      <Text font={14} fontWeight={key === filter ? "semibold" : "medium"} lineLimit={1} minScaleFactor={0.8}>
                        {shipmentFilters[key]}
                      </Text>
                      <Text font={11} fontWeight="semibold" monospacedDigit foregroundStyle="secondaryLabel"
                        lineLimit={1} padding={{ horizontal: 4 }} frame={{ minWidth: 16, minHeight: 16 }}
                        background={{ style: "systemFill", shape: "capsule" }}
                        contentTransition="numericText"
                        animation={{ animation: Animation.snappy({ duration: 0.32 }), value: groups[key].length }}>
                        {groups[key].length}
                      </Text>
                    </HStack>
                  </Button>
                ))}
              </HStack>
            </ZStack>
          );
        }}
      </GeometryReader>
    </VStack>
  );
}

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
  /** Starts the pull's cloud work and returns its international Watch read, which the toast waits for (G-HIGH-10). */
  onListPull?: () => Promise<WatchPullOutcome> | void;
  platformNotice?: Readonly<{ text: string }>;
  /** Shows the Settings tab, where the Access Key is entered. */
  onOpenSettings?: () => void;
}) {
  const dismiss = Navigation.useDismiss();
  const pullInFlight = useRef<Promise<void> | null>(null);
  const [deleting, setDeleting] = useState(false);
  const deletingRef = useRef(false);
  /** E1: a pull's background completion applies its result only while this page is mounted. */
  const mountedRef = useRef(true);
  const [completing, setCompleting] = useState(false);
  const completingRef = useRef(false);
  const [notice, setNotice] = useState("");
  const searchPresented = useObservable(props.autoFocusSearch && !props.initialShipmentId);
  const handledNavigationRef = useRef<number | undefined>(undefined);
  const [accessKeyNoticeKind, setAccessKeyNoticeKind] = useState(accessKeyReminder);
  // Closing a notice hides that kind for this page; a different notice still appears.
  const [dismissedAccessKeyNotice, setDismissedAccessKeyNotice] = useState<AccessKeyReminder | null>(null);
  const [shipmentNavigationTarget, setShipmentNavigationTargetState] = useState<
    ShipmentNavigationTarget | null
  >(() => props.initialShipmentId && props.shipments.some(
    (shipment) => shipment.identity.id === props.initialShipmentId,
  ) ? persistedShipmentNavigationTarget(props.initialShipmentId) : null);
  const shipmentNavigationTargetRef = useRef(shipmentNavigationTarget);
  const shipments = props.shipments;
  const groups = useMemo(() => {
    type Item = { id: string; shipment: Shipment; deleting: boolean; completing: boolean };
    const buckets: Record<ShipmentFilter, Item[]> = { all: [], transit: [], pickup: [], danger: [] };
    for (const shipment of shipments) {
      const item = { id: shipment.identity.id, shipment, deleting, completing };
      buckets.all.push(item);
      const bucket = shipmentFilter(shipmentPresentationStatus(shipment).semantic);
      if (bucket) buckets[bucket].push(item);
    }
    return buckets;
  }, [shipments, deleting, completing]);
  const visibleFilters = (Object.keys(shipmentFilters) as ShipmentFilter[])
    .filter((key) => key === "all" || groups[key].length > 0);
  const selection = useRef({ filter: "all" as ShipmentFilter, items: groups.all });
  const filter = visibleFilters.includes(selection.current.filter) ? selection.current.filter : "all";
  const observableItems = useObservable(() => selection.current.items);

  function showFilter(next: ShipmentFilter) {
    if (!visibleFilters.includes(next)) return;
    const items = groups[next];
    if (selection.current.items === items) return;
    selection.current = { filter: next, items };
    observableItems.setValue(items);
  }

  useEffect(() => {
    const selected = selection.current.filter;
    showFilter(visibleFilters.includes(selected) ? selected : "all");
  }, [groups]);
  const rowActions = useRef({ openShipment, confirmDelete, confirmComplete });
  rowActions.current = { openShipment, confirmDelete, confirmComplete };
  const rowHandlers = useRef(new Map<string, {
    shipment: Shipment;
    onOpen: () => void;
    onDelete: () => void;
    onComplete: () => void;
  }>());
  useEffect(() => {
    const liveIds = new Set(shipments.map((item) => item.identity.id));
    for (const key of rowHandlers.current.keys()) {
      if (!liveIds.has(key)) rowHandlers.current.delete(key);
    }
  }, [shipments]);
  function rowHandlersFor(id: string, shipment: Shipment) {
    let cached = rowHandlers.current.get(id);
    if (!cached) {
      const entry = {
        shipment,
        onOpen: () => rowActions.current.openShipment(entry.shipment),
        onDelete: () => void rowActions.current.confirmDelete(entry.shipment),
        onComplete: () => void rowActions.current.confirmComplete(entry.shipment),
      };
      rowHandlers.current.set(id, entry);
      cached = entry;
    } else {
      cached.shipment = shipment;
    }
    return cached;
  }
  const candidate = selectedNavigationShipment(
    props.state,
    shipmentNavigationTarget,
  );
  const selected = internationalShipment(candidate) &&
    !shipments.some(row => row.identity.id === candidate?.identity.id) ? null : candidate;
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
    return subscribeAccessKeyReminder(setAccessKeyNoticeKind);
  }, []);

  useEffect(() => {
    if (props.platformNotice) setNotice(props.platformNotice.text);
  }, [props.platformNotice]);

  useEffect(() => {
    mountedRef.current = true;
    // 所有副本都迁移失败时不是空库，而是读取失败（2026-09-06 静态审查②）：进页先说一声。
    if (stateLoadFailure()) setNotice(EXPRESS_TOAST_COPY.stateLoadFailed);
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const generation = props.navigationRequestGeneration;
    if (handledNavigationRef.current === generation) return;
    handledNavigationRef.current = generation;
    if (props.initialShipmentId && props.shipments.some(
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

  async function runListPull() {
    setNotice("");
    try {
      // E1 (owner 2026-11-10): the spinner ends once the account phase is stored; the per-shipment work
      // goes on in the same refresh and is published by the app's refresh subscription.
      const { summary, completion } = await refreshAllShipmentsForPull(undefined, {
        accountSourceFollowup: true,
      });
      applyInteractiveRefreshSummary(summary);
      // The international Watch rows are part of the pull: its toast waits for their read and counts it (G-HIGH-10).
      const watch = await Promise.resolve(props.onListPull?.()).catch((): WatchPullOutcome => "failed");
      setNotice(refreshSummaryToast(withWatchPullOutcome(summary, watch || undefined)));
      if (summary.continuing) followPullCompletion(completion);
    } catch (error) {
      // One gesture, one outcome: refreshAllShipments resolves with failures on the line above
      // and rejects here, so both branches have to say 刷新失败 rather than 查询失败.
      setNotice(EXPRESS_TOAST_COPY.refreshFailed);
    }
  }

  const currentPull = useRef(runListPull);
  currentPull.current = runListPull;
  const refresh = useCallback(() => {
    pullInFlight.current ??= currentPull.current().finally(() => { pullInFlight.current = null; });
    return pullInFlight.current;
  }, []);

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
    if (typeof synchronizeParcelCloudRecords === "function") {
      void synchronizeParcelCloudRecords().catch(() => undefined);
    }
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
    if (typeof synchronizeParcelCloudRecords === "function") {
      void synchronizeParcelCloudRecords().catch(() => undefined);
    }
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
  useEffect(() => {
    if (!accessKeyNoticeKind) setDismissedAccessKeyNotice(null);
  }, [accessKeyNoticeKind]);
  const shownAccessKeyNotice = accessKeyNoticeKind && accessKeyNoticeKind !== dismissedAccessKeyNotice
    ? accessKeyNoticeKind : null;
  // Every notice opens the Settings root, where the key is entered again; the rejected notice keeps its text
  // (owner decision 2026-11-21: 「已失效」提醒也能点进设置（推荐）).
  const openAccessKeySettings = shownAccessKeyNotice ? props.onOpenSettings : undefined;
  const accessKeyNoticeText = shownAccessKeyNotice ? (
    <Text
      font={14}
      foregroundStyle="secondaryLabel"
      frame={{ maxWidth: "infinity", minHeight: 44, alignment: "leading" }}
      contentShape="rect"
    >
      {ACCESS_KEY_NOTICE_COPY[shownAccessKeyNotice]}
    </Text>
  ) : <VStack />;
  const accessKeyNotice = shownAccessKeyNotice ? (
    <VStack listRowInsets={{ top: 0, bottom: 0, leading: ROOT_PAGE_MARGIN, trailing: ROOT_PAGE_MARGIN }}
      listRowBackground={<Rectangle fill="clear" />} listRowSeparator="hidden">
      <HStack
        spacing={0}
        padding={{ leading: 16, trailing: 8, vertical: 8 }}
        background="secondarySystemBackground"
        clipShape={{ type: "rect", cornerRadius: 20, style: "continuous" }}
      >
        {openAccessKeySettings ? (
          <Button buttonStyle="plain" action={openAccessKeySettings}>
            {accessKeyNoticeText}
          </Button>
        ) : accessKeyNoticeText}
        <Button
          accessibilityLabel="关闭提示"
          role="close"
          buttonStyle="plain"
          action={() => setDismissedAccessKeyNotice(shownAccessKeyNotice)}
        >
          <Image
            systemName="xmark"
            font={16}
            foregroundStyle="secondaryLabel"
            frame={{ width: 44, height: 44 }}
            contentShape="rect"
          />
        </Button>
      </HStack>
    </VStack>
  ) : null;

  const shipmentListFooter = (
    <Text
      font="caption"
      foregroundStyle="tertiaryLabel"
      frame={{ maxWidth: "infinity", alignment: "center" }}
      padding={{ top: 6, bottom: 12 }}
    >
      只显示 14 天内的快递
    </Text>
  );

  return (
    <NavigationStack>
      <VStack spacing={0}
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
        toast={searchPresented.value ? undefined : transientToast(notice, setNotice)}
        sheet={{
          isPresented: searchPresented,
          content: (
            <NavigationStack
              background="systemGroupedBackground"
              presentationDetents={[280, "medium", "large"]}
              presentationDragIndicator="visible"
            >
              <ScrollView navigationTitle="查询快递" navigationBarTitleDisplayMode="inline" scrollIndicator="never"
                scrollDismissesKeyboard="interactively"
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
                  open={searchPresented.value}
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
              visibleShipments={shipments}
              persistedShipment={props.state.shipments.some(
                (shipment) => shipment.identity.id === selected.identity.id,
              )}
              accountBinding={props.state.bindings.find((binding) =>
                binding.source === selected.identity.bindingSource && binding.phone === selected.accountRecord?.phone)}
              attachedOrders={selectedAttachedOrders}
              manualPreview={manualPreview}
              refreshOnAppear={internationalShipment(selected) ? watchDetailOpenRefreshes(selected) ? "detail_open" : false : manualPreview
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
        <RootTabList key="shipments" title="快递" onClose={() => dismiss()}
          refresh={refresh} bottomInset={TAB_FAB_SCROLL_INSET}
          titleAction={(
            <VStack padding={TAB_FAB_PADDING}>
              <TabFloatingActionButton title="查询" symbol="magnifyingglass" action={() => searchPresented.setValue(true)} />
            </VStack>
          )}
          emptyState={!shipments.length ? <EmptyTabState /> : undefined}
          topAccessory={visibleFilters.length > 1 ? (
            <ShipmentFilterBar visibleFilters={visibleFilters} filter={filter} groups={groups} onSelect={showFilter} />
          ) : null}>
          {accessKeyNotice ? (
            <Section listSectionMargins={0} listSectionSpacing={16} listSectionSeparator="hidden">
              {accessKeyNotice}
            </Section>
          ) : null}
          {shipments.length ? (
            <Section listSectionMargins={{ edges: "vertical", length: 0 }}
              footer={shipmentListFooter}
              listSectionSeparator={{ visibility: "hidden", edges: "top" }}>
              <ForEach data={observableItems} builder={({ id, shipment, deleting, completing }) => (
                <ShipmentRow
                  key={id}
                  shipment={shipment}
                  onOpen={rowHandlersFor(id, shipment).onOpen}
                  onDelete={rowHandlersFor(id, shipment).onDelete}
                  onComplete={rowHandlersFor(id, shipment).onComplete}
                  deleteDisabled={deleting}
                  completeDisabled={completing}
                />
              )} />
            </Section>
          ) : null}
        </RootTabList>
      </VStack>
    </NavigationStack>
  );
}

function HomeSearchBar(props: {
  open: boolean;
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
  const carrierRequest = useRef<{ waybill: string; controller: AbortController } | null>(null);
  const carrierDetectionCoordinatorRef = useRef<
    ManualCarrierDetectionCoordinator | null
  >(null);
  if (!carrierDetectionCoordinatorRef.current) {
    carrierDetectionCoordinatorRef.current = new ManualCarrierDetectionCoordinator();
  }
  const storedWaybills = useMemo(() => {
    const index = new Map<string, Shipment[]>();
    if (!props.open && !props.shortcutLookup) return index;
    for (const shipment of props.state.shipments) {
      const waybill = normalizeWaybill(displayWaybill(shipment));
      if (!waybill) continue;
      const candidates = index.get(waybill);
      if (candidates) candidates.push(shipment);
      else index.set(waybill, [shipment]);
    }
    return index;
  }, [props.open, Boolean(props.shortcutLookup), props.state.shipments]);
  const phoneTailValidation = validationNotice.includes("手机尾号");

  function cancelCarrierDetection(keepWaybill?: string) {
    carrierDetectionSequenceRef.current += 1;
    if (carrierDetectionTimerRef.current !== null) clearTimeout(carrierDetectionTimerRef.current);
    carrierDetectionTimerRef.current = null;
    if (carrierRequest.current && carrierRequest.current.waybill !== keepWaybill) {
      carrierRequest.current.controller.abort();
      carrierRequest.current = null;
    }
  }

  useEffect(() => {
    return () => {
      shortcutGenerationRef.current += 1;
      cancelCarrierDetection();
    };
  }, []);

  useEffect(() => {
    if (!props.shortcutLookup) return;
    shortcutGenerationRef.current = props.shortcutGeneration;
    cancelCarrierDetection();
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
    cancelCarrierDetection(normalized);
    const sequence = carrierDetectionSequenceRef.current;
    // A waybill already in the list answers for itself, with no request and no cache to consult.
    const stored = storedCarrierDetection(normalized, storedWaybills.get(normalized) ?? []);
    setDetectedCarrier(stored);
    if (stored) return;
    // Recognition is a network question, so it waits for a number that looks finished rather than
    // firing on every prefix; a 16-digit waybill used to spend ten recognitions on its way in.
    if (normalized.length < CARRIER_DETECTION_MIN_LENGTH) return;

    carrierDetectionTimerRef.current = setTimeout(() => {
      carrierDetectionTimerRef.current = null;
      const controller = carrierRequest.current?.controller ?? new AbortController();
      carrierRequest.current = { waybill: normalized, controller };
      void carrierDetectionCoordinatorRef.current!.resolve(normalized, { signal: controller.signal })
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
        })
        .finally(() => {
          if (carrierRequest.current?.controller === controller) carrierRequest.current = null;
        });
    }, CARRIER_DETECTION_DEBOUNCE_MS);
  }

  function clearQueryInputs() {
    cancelCarrierDetection();
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
    // D110: the Home add flow ends with one line: already listed, a pickup code that could not be saved, a phone tail
    // still needed, committed or failed. Only the waybill's last four characters are written (D5).
    const finish = beginDiagnosticOperation("home.query", {
      stage: "manual_query", waybillTail: waybillSuffix(submittedNormalized),
      trigger: lookup ? "shortcut" : "manual",
    });
    // Checked before carrier detection and before any provider round: a waybill the list already
    // tracks must not spend a recognition call, a provider query or a second row.
    const alreadyListed = props.shipments.find(
      (shipment) => normalizeWaybill(displayWaybill(shipment)) === submittedNormalized,
    );
    if (alreadyListed) {
      if (lookup?.pickup) {
        try {
          props.onStateChange(saveRecognizedShipmentPickup(alreadyListed, lookup));
        } catch (error) {
          finish("pickup_save_failed", diagnosticErrorDetails(error), "warning");
          setNotice("取件码保存失败，请稍后重试");
          return;
        }
      }
      finish("already_listed");
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
      finish("awaiting_phone_tail");
      return;
    }
    queryingRef.current = true;
    setQuerying(true);
    // An explicit query takes ownership of the already-running detection for its waybill.
    cancelCarrierDetection(submittedNormalized);
    carrierRequest.current = null;
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
      if (shortcutGeneration !== shortcutGenerationRef.current) {
        finish("cancelled");
        return;
      }
      if (submittedCarrier) setDetectedCarrier(submittedCarrier);
      if (
        (submittedCarrier?.requiresPhoneTail || needsPhoneTail) &&
        submittedPhoneTail.length !== 4
      ) {
        setNeedsPhoneTail(true);
        setValidationNotice(
          submittedPhoneTail ? "请输入 4 位手机尾号" : "请输入手机尾号",
        );
        finish("awaiting_phone_tail");
        return;
      }
      const preview = await queryManualShipmentPreview({
        waybill: submittedWaybill,
        phoneTail: submittedPhoneTail,
        presentation: submittedCarrier,
      });
      const committed = commitManualShipmentPreview(preview, Date.now(), lookup);
      finish("committed");
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
      const message = errorMessage(error, "");
      // The end function writes once: a commit that already ended keeps its result.
      finish(message.includes("手机尾号") ? "awaiting_phone_tail"
        : isManualQueryValidationMessage(message) ? "invalid_input" : "failed",
        diagnosticErrorDetails(error), isManualQueryValidationMessage(message) ? "info" : "warning");
      if (shortcutGeneration !== shortcutGenerationRef.current) return;
      // 校验类文案内联显示；其余一律走统一的失败 / 超时 toast，上游文案不外露。
      const value = message;
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
      {/* Owner 2026-11-20: the query and phone-tail inputs share one surface and metrics. */}
      <HStack
        spacing={INPUT_ROW_ICON_GAP}
        padding={{ horizontal: INPUT_ROW_INSET }}
        frame={{ minHeight: INPUT_ROW_HEIGHT, maxWidth: "infinity" }}
        background={{ style: "secondarySystemGroupedBackground", shape: { type: "rect", cornerRadius: 16, style: "continuous" } }}
      >
        <Image
          systemName="magnifyingglass"
          font={INPUT_ROW_ICON_SIZE}
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
          prompt="请输入运单号"
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
          spacing={INPUT_ROW_ICON_GAP}
          padding={{ horizontal: INPUT_ROW_INSET }}
          frame={{ minHeight: INPUT_ROW_HEIGHT, maxWidth: "infinity" }}
          background={{ style: "secondarySystemGroupedBackground", shape: { type: "rect", cornerRadius: 16, style: "continuous" } }}
        >
          <Image
            systemName="phone"
            font={INPUT_ROW_ICON_SIZE}
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
              <Text font="footnote" foregroundStyle="systemRed" lineLimit={1}>
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
