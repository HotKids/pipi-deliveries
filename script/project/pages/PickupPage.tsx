import { AppEvents, Button, Divider, HStack, Navigation, NavigationStack, Section, Text, VStack, useCallback, useEffect, useMemo, useRef, useState } from "scripting";
import type { AppState, Shipment } from "../models";
import { ParcelActivityPreviewCard, PickupTabCard } from "../components/PickupTabCard";
import { EmptyTabState, type PickupEmptyArtwork } from "../components/EmptyDeliveryVehicle";
import { ExpandedQRCode, ScanCodeSurface } from "../components/ExpandedScanCode";
import { RootTabList } from "../components/RootPageHeader";
import { FloatingActions, ROOT_PAGE_BG, TAB_FAB_SCROLL_INSET } from "../components/TabFloatingActionButton";
import { synchronizeParcelCloudRecords } from "../services/parcel-cloud-sync";
import { stopParcelActivityPreview, type MealQRCodeTarget } from "../services/parcel-live-activity";
import { PICKUP_DATE_GROUP_SPACING, parcelCardArtwork } from "../services/parcel-card-appearance";
import { PICKUP_TAB_TITLE, createPickupAnimationGate, pickupDateSections, shipmentForPickupTarget, type ParcelActivityContent, type ParcelActivityTarget } from "../services/parcel-pickup";
import { projectionSceneActive } from "../services/projection-viewport";
import { copyText } from "../services/clipboard";
import { EXPRESS_TOAST_COPY, MEAL_TOAST_COPY, PICKUP_TOAST_COPY } from "../services/express-toast-copy";
import { accountStatus, onPlatformAccountsChanged, type IdentityPlatform } from "../services/platform-accounts";
import { stationIdentityDestination } from "../services/platform-wire";
import { parseHandoffWindow } from "../services/platform-parcel-data";
import { needsDetailEntryQuery } from "../services/shipment-policy";
import { noteSavedToast, noteSaveFailedToast, SAVE_FAILED_TOAST, type transientToast } from "../services/ui-feedback";
import { ShipmentLifecycleChangedError } from "../services/shipment-lifecycle";
import { safeRead } from "../services/safe-read";
import { mealRedemption } from "../services/meal/cards";
import { currentMeal, deleteMeal, readMeals } from "../services/meal/records";
import { mealCredentialScope } from "../services/meal/rules";
import { deleteIndependentParcelCode, parcelCardKey, setParcelHandoffWindow, setPickupCardNote } from "../services/storage";
import { attachedProjectedOrders } from "../services/waybill-ownership";
import { diagnosticErrorDetails, writeDiagnostic } from "../services/logger";
import { requestWidgetReload } from "../services/widgets";
import { DetailPage } from "./DetailPage";
import { PlatformWebLogin } from "./PlatformAccountPages";
import { IDENTITY_CODE_TITLES, StationIdentityMark, StationIdentityPage } from "./StationIdentityPage";
import { pickupCabinetActions } from "../services/platform-parcel-sync";

const IDENTITY_CHOICES = [
  { platform: "cainiao", title: "菜鸟驿站" },
  { platform: "pinduoduo", title: "多多驿站" },
] as const;

type PickupIdentityDestination =
  | { platform: IdentityPlatform; route: "local" }
  | { platform: IdentityPlatform; route: "login"; generation: string };

function IdentityCodeButton({ onOpen }: {
  onOpen: (platform: IdentityPlatform) => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  return (
    <FloatingActions
      items={[
        {
          symbol: "person.text.rectangle",
          label: "身份码",
          title: "身份码",
          anchorPad: 44,
          action: () => setShowPicker(!showPicker),
          popover: {
            isPresented: showPicker,
            onChanged: setShowPicker,
            arrowEdge: "bottom",
            presentationCompactAdaptation: "popover",
            content: (
              <VStack alignment="leading" spacing={0} padding={6} fixedSize={{ horizontal: true, vertical: true }}>
                {IDENTITY_CHOICES.flatMap(({ platform, title }, index) => [
                  ...(index > 0 ? [<Divider key={`${platform}-divider`} />] : []),
                  <Button key={platform} buttonStyle="plain" contentShape="rect" action={() => {
                    setShowPicker(false);
                    onOpen(platform);
                  }}>
                    <HStack spacing={10} padding={{ horizontal: 10, vertical: 9 }}>
                      <StationIdentityMark asset={platform} />
                      <Text font={17} foregroundStyle="label" fixedSize={{ horizontal: true, vertical: true }}>{title}</Text>
                    </HStack>
                  </Button>,
                ])}
              </VStack>
            ),
          },
        },
      ]}
    />
  );
}

function PickupCardRow({ card, animate, spaceAfter, width, note, opensCabinet, actionBlocked, onDetail, onSaveNote, onSaveWindow, onAction,
  showNotice, onMealCode, onArtworkChange, deleteAction }: {
  card: ParcelActivityContent;
  animate: boolean;
  spaceAfter: boolean;
  width?: number;
  note: string;
  opensCabinet: boolean;
  actionBlocked: boolean;
  onDetail?: () => void;
  onSaveNote?: (note: string) => void;
  onSaveWindow?: (window: [number, number] | undefined) => void;
  onAction: (card: ParcelActivityContent, openCabinet: boolean) => Promise<void>;
  showNotice: (message: string) => void;
  onMealCode?: () => void;
  onArtworkChange: (card: ParcelActivityContent) => boolean;
  deleteAction?: { title: string; onDelete: () => void };
}) {
  const [showAddress, setShowAddress] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const [artworkChanged, setArtworkChanged] = useState(false);
  const acting = useRef(false);
  const editing = useRef(false);
  const canSwitch = Boolean(card.kind !== "handoff" && card.address && card.location && card.location !== card.address);
  useEffect(() => { if (!animate) setArtworkChanged(false); }, [animate]);

  async function editNote() {
    if (editing.current || !onSaveNote) return;
    editing.current = true;
    try {
      const value = await Dialog.prompt({
        title: "编辑备注", message: "清空后保存可删除备注", defaultValue: note,
        placeholder: "请输入备注", cancelLabel: "取消", confirmLabel: "保存",
      });
      if (value == null) return;
      onSaveNote(value);
      showNotice(noteSavedToast(value));
    } catch (error) {
      showNotice(noteSaveFailedToast(error));
    } finally {
      editing.current = false;
    }
  }

  async function editWindow() {
    if (editing.current || !onSaveWindow) return;
    editing.current = true;
    try {
      const value = await Dialog.prompt({
        title: "编辑上门时间", message: "清空可移除上门时间", defaultValue: card.location.replace(/ 上门$/, ""),
        placeholder: "如 11-19 15:00–17:00", cancelLabel: "取消", confirmLabel: "保存",
      });
      if (value == null) return;
      const text = value.trim();
      const now = Date.now();
      const window = text ? parseHandoffWindow(text, now, true) : undefined;
      if (text && (!window || window[1] + 3_600_000 <= now)) {
        showNotice(PICKUP_TOAST_COPY.handoffWindowInvalid);
        return;
      }
      onSaveWindow(window);
      showNotice(PICKUP_TOAST_COPY.handoffWindowSaved);
    } catch (error) {
      // A record that changed after the prompt opened is not a failed save (G-LOW-04), as on Pipi's pickup card.
      showNotice(error instanceof ShipmentLifecycleChangedError ? PICKUP_TOAST_COPY.pickupCardChanged : SAVE_FAILED_TOAST);
    } finally {
      editing.current = false;
    }
  }

  async function complete() {
    if (acting.current || actionBlocked) return;
    acting.current = true;
    setActionPending(true);
    try {
      await onAction(card, opensCabinet);
    } finally {
      acting.current = false;
      setActionPending(false);
    }
  }

  async function copyCode() {
    if (!card.code.trim()) return;
    const result = await copyText(card.code);
    if (card.kind === "meal") {
      showNotice(result === "copied" ? MEAL_TOAST_COPY.codeCopied : MEAL_TOAST_COPY.copyFailed);
    } else {
      const success = card.kind === "handoff" ? EXPRESS_TOAST_COPY.handoffCodeCopied : EXPRESS_TOAST_COPY.pickupCodeCopied;
      showNotice(result === "copied" ? success : EXPRESS_TOAST_COPY.copyFailed);
    }
  }

  const latestRowCallbacks = useRef({ copyCode, editNote, editWindow, complete, onArtworkChange, card });
  latestRowCallbacks.current = { copyCode, editNote, editWindow, complete, onArtworkChange, card };
  const handleCopy = useCallback(() => void latestRowCallbacks.current.copyCode(), []);
  const handleEditNote = useCallback(() => void latestRowCallbacks.current.editNote(), []);
  const handleEditWindow = useCallback(() => void latestRowCallbacks.current.editWindow(), []);
  const handleArtworkTap = useCallback(() => {
    const { onArtworkChange: change, card: currentCard } = latestRowCallbacks.current;
    if (change(currentCard)) setArtworkChanged(true);
  }, []);
  const handleComplete = useCallback(() => void latestRowCallbacks.current.complete(), []);

  return (
    <PickupTabCard
      data={card}
      animate={animate && !artworkChanged}
      spaceAfter={spaceAfter}
      width={width}
      title={note || card.title}
      onCopy={onMealCode ?? handleCopy}
      onDetail={onDetail}
      onEditNote={card.target && onSaveNote ? handleEditNote : undefined}
      actionLabel={opensCabinet ? "一键开柜" : undefined}
      actionPending={actionPending || actionBlocked}
      locationText={canSwitch && showAddress ? card.address : card.location || (onSaveWindow ? "设置上门时间" : "")}
      showingAddress={canSwitch && showAddress}
      onLocationTap={canSwitch ? () => setShowAddress(!showAddress) : onSaveWindow ? handleEditWindow : undefined}
      onArtworkTap={card.artworkSwitchable ? handleArtworkTap : undefined}
      onComplete={card.target ? handleComplete : undefined}
      deleteAction={deleteAction}
    />
  );
}

export function PickupPage({
  state, shipments, cards, previewing, emptyArtwork, focusedRecordId, activityMealQRCode, onActivityMealQRCodeHandled,
  onAction, onStateChange, showNotice, toast, onArtworkChange, onRefresh, onMealDeleted,
}: {
  state: AppState;
  shipments: readonly Shipment[];
  cards: readonly ParcelActivityContent[];
  previewing: boolean;
  emptyArtwork: PickupEmptyArtwork;
  focusedRecordId: string;
  activityMealQRCode?: MealQRCodeTarget;
  onActivityMealQRCodeHandled: (target: MealQRCodeTarget) => void;
  onAction: (card: ParcelActivityContent, openCabinet: boolean) => Promise<void>;
  onStateChange: (state: AppState) => void;
  showNotice: (message: string) => void;
  toast: ReturnType<typeof transientToast>;
  onArtworkChange: (card: ParcelActivityContent) => boolean;
  onRefresh?: () => Promise<void>;
  onMealDeleted?: () => void;
}) {
  const dismiss = Navigation.useDismiss();
  const [mealQr, setMealQr] = useState<MealQRCodeTarget | null>(activityMealQRCode ?? null);
  const [detailTarget, setDetailTarget] = useState<ParcelActivityTarget | undefined>(undefined);
  const [identity, setIdentity] = useState<PickupIdentityDestination | null>(null);
  const identityRequest = useRef(0);
  const [visible, setVisible] = useState(false);
  const [animationReady, setAnimationReady] = useState(false);
  const animationGateRef = useRef<ReturnType<typeof createPickupAnimationGate> | null>(null);
  if (!animationGateRef.current) {
    animationGateRef.current = createPickupAnimationGate(setAnimationReady);
  }
  const [cabinetRevision, setCabinetRevision] = useState(0);
  const [closingPreview, setClosingPreview] = useState(false);
  useEffect(() => {
    const gate = animationGateRef.current!;
    gate.setSceneActive(projectionSceneActive());
    const observe = (phase: "active" | "inactive" | "background") => {
      gate.setSceneActive(phase === "active");
    };
    AppEvents.scenePhase.addListener(observe);
    return () => {
      AppEvents.scenePhase.removeListener(observe);
      gate.dispose();
    };
  }, []);
  useEffect(() => {
    animationGateRef.current!.setVisible(visible);
  }, [visible]);
  useEffect(() => {
    if (!activityMealQRCode) return;
    identityRequest.current++;
    setIdentity(null);
    setDetailTarget(undefined);
    setMealQr(activityMealQRCode);
    onActivityMealQRCodeHandled(activityMealQRCode);
  }, [activityMealQRCode, onActivityMealQRCodeHandled]);
  useEffect(() => visible ? onPlatformAccountsChanged(platform => {
    if (platform === "fengchao") setCabinetRevision(value => value + 1);
  }) : undefined, [visible]);
  useEffect(() => () => { identityRequest.current++; }, []);
  const cabinetActions = useMemo(() => visible ? pickupCabinetActions(cards) : undefined,
    [cards, visible, cabinetRevision]);
  const selected = shipmentForPickupTarget(shipments, detailTarget);
  const attachedOrders = useMemo(() => selected ? attachedProjectedOrders(state.shipments, selected) : undefined,
    [state.shipments, selected]);
  const records = state.pickupCodeRecords;
  const sections = useMemo(() => pickupDateSections(cards, previewing, focusedRecordId), [cards, previewing, focusedRecordId]);
  const mealQrCard = mealQr && cards.find(card => card.target && "mealId" in card.target &&
    card.target.mealId === mealQr.id && card.target.mealScope === mealQr.scope);
  // A render-time Keychain or storage read cannot throw out of the page (G-MED-20).
  const shownQr = mealQr && mealQrCard ? safeRead(() => mealCredentialScope() === mealQr.scope
    ? currentMeal(readMeals(mealQr.scope), mealQr.id) : undefined, undefined) : undefined;
  const redemption = shownQr ? mealRedemption(shownQr) : undefined;
  const closeMealCode = () => setMealQr(null);

  async function closePreview() {
    if (closingPreview) return;
    setClosingPreview(true);
    try { await stopParcelActivityPreview(); }
    catch { showNotice(PICKUP_TOAST_COPY.previewStopFailed); }
    finally { setClosingPreview(false); }
  }

  async function confirmDeleteMeal(mealScope: string, mealId: string): Promise<void> {
    try {
      const confirmed = await Dialog.confirm({
        title: "删除取餐码", message: "删除后将不在「待取」显示。", cancelLabel: "取消", confirmLabel: "删除",
      });
      if (!confirmed) return;
      const deleted = mealCredentialScope() === mealScope && deleteMeal(mealScope, mealId);
      showNotice(deleted ? MEAL_TOAST_COPY.deleted : MEAL_TOAST_COPY.deleteFailed);
      if (deleted) onMealDeleted?.();
    } catch {
      showNotice(MEAL_TOAST_COPY.deleteFailed);
    }
  }

  async function confirmDeleteParcelRecord(recordId: string, handoff: boolean): Promise<void> {
    const label = handoff ? "寄件码" : "取件码";
    try {
      const confirmed = await Dialog.confirm({
        title: `删除${label}`, message: `删除后将不在「待取」显示。`, cancelLabel: "取消", confirmLabel: "删除",
      });
      if (!confirmed) return;
      onStateChange(deleteIndependentParcelCode(recordId));
      if (typeof synchronizeParcelCloudRecords === "function") {
        void synchronizeParcelCloudRecords().catch(() => undefined);
      }
      requestWidgetReload();
      showNotice(handoff ? PICKUP_TOAST_COPY.handoffRecordDeleted : EXPRESS_TOAST_COPY.pickupRecordDeleted);
    } catch (error) {
      showNotice(error instanceof ShipmentLifecycleChangedError
        ? PICKUP_TOAST_COPY.pickupCardChanged
        : EXPRESS_TOAST_COPY.deleteFailed);
    }
  }

  // The picker calls this without awaiting it, so a failed Keychain read is reported here instead of ending the
  // Scripting session (G-HIGH-17). stationIdentityDestination writes its own failure line.
  async function openIdentity(platform: IdentityPlatform) {
    const request = ++identityRequest.current;
    let routed = false;
    try {
      const route = await stationIdentityDestination(platform, (url) => Safari.openURL(url));
      routed = true;
      if (request !== identityRequest.current) return;
      setIdentity(route === "login" ? { platform, route, generation: accountStatus(platform).generation }
        : route === "local" ? { platform, route } : null);
    } catch (error) {
      if (routed) {
        writeDiagnostic("platform.identity.completed", { sourceProvider: platform, stage: "station_identity_entry",
          result: "failed", ...diagnosticErrorDetails(error) }, "warning");
      }
      if (request === identityRequest.current) showNotice(EXPRESS_TOAST_COPY.pickupRecordActionFailed);
    }
  }

  function cardRow(card: ParcelActivityContent, animate: boolean, spaceAfter: boolean, sheetWidth?: number) {
    const target = card.target;
    const key = parcelCardKey(card);
    if (target && "mealId" in target) {
      // Inside ExpandedQRCode, tapping any visible meal pickup code copies it instead of closing the sheet.
      const copyableInSheet = sheetWidth !== undefined &&
        Boolean(card.code.trim()) && card.code !== "待取餐" && card.code !== "待核销";
      return <PickupCardRow key={key} card={card} animate={animate} spaceAfter={spaceAfter} width={sheetWidth} note=""
        opensCabinet={false} actionBlocked={false} onAction={onAction} showNotice={showNotice}
        onArtworkChange={onArtworkChange}
        deleteAction={sheetWidth === undefined ? {
          title: "删除取餐码",
          onDelete: () => void confirmDeleteMeal(target.mealScope, target.mealId),
        } : undefined}
        onMealCode={card.hasMealQR && !copyableInSheet ? sheetWidth !== undefined ? closeMealCode
          : () => setMealQr({ id: target.mealId, scope: target.mealScope }) : undefined} />;
    }
    const shipment = shipmentForPickupTarget(shipments, target);
    const record = target && "recordId" in target ? records?.find((record) => record.id === target.recordId) : undefined;
    const note = (record?.note ?? shipment?.note) || "";
    const handoff = card.kind === "handoff";
    return (
      <PickupCardRow key={key} card={card} animate={animate} spaceAfter={spaceAfter}
        note={note} opensCabinet={Boolean(cabinetActions?.has(card))}
        actionBlocked={card.platform === "fengchao" && !cabinetActions} onAction={onAction}
        onArtworkChange={onArtworkChange}
        showNotice={showNotice} onDetail={shipment ? () => {
          identityRequest.current++;
          setDetailTarget(target);
        } : undefined}
        deleteAction={record ? {
          title: handoff ? "删除寄件码" : "删除取件码",
          onDelete: () => void confirmDeleteParcelRecord(record.id, handoff),
        } : undefined}
        onSaveWindow={record?.kind === "handoff" ? window => {
          onStateChange(setParcelHandoffWindow(record, window));
          if (typeof synchronizeParcelCloudRecords === "function") {
            void synchronizeParcelCloudRecords().catch(() => undefined);
          }
        } : undefined}
        onSaveNote={(value) => {
          onStateChange(setPickupCardNote(card, note, value));
          if (typeof synchronizeParcelCloudRecords === "function") {
            void synchronizeParcelCloudRecords().catch(() => undefined);
          }
          if (shipment) requestWidgetReload();
        }} />
    );
  }

  return (
    <NavigationStack toolbarBackgroundVisibility={{ visibility: "hidden", bars: ["navigationBar"] }}>
      <VStack spacing={0} toast={toast}
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
        background={ROOT_PAGE_BG}
        toolbarBackground={{ style: ROOT_PAGE_BG, bars: ["tabBar"] }}
        onAppear={() => { setVisible(true); animationGateRef.current?.setVisible(true); }}
        onDisappear={() => { setVisible(false); animationGateRef.current?.setVisible(false); }}
        sheet={{
          isPresented: Boolean(redemption && mealQrCard),
          onChanged: shown => { if (!shown) closeMealCode(); },
          content: redemption && mealQrCard ? (
            <VStack presentationDragIndicator="visible" frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
              <ScanCodeSurface followsSystemAppearance>
                <ExpandedQRCode data={redemption.payload} title={shownQr?.brandName?.trim() || redemption.title}
                  titleLogo={parcelCardArtwork(mealQrCard).mark?.path}
                  hint={redemption.prompt} header={width => cardRow(mealQrCard, true, false, width)}
                  close={{ label: `关闭${redemption.title}`, action: closeMealCode }} />
              </ScanCodeSurface>
            </VStack>
          ) : <VStack />,
        }}
        navigationDestination={{
          isPresented: Boolean(identity || selected),
          onChanged: (presented) => {
            if (!presented) {
              identityRequest.current++;
              setIdentity(null);
              setDetailTarget(undefined);
            }
          },
          content: identity
            ? identity.route === "login"
              ? <PlatformWebLogin key={identity.platform} platform={identity.platform}
                  generation={identity.generation}
                  embedded={{
                    title: IDENTITY_CODE_TITLES[identity.platform],
                    onFinished: (saved) => setIdentity(saved ? { platform: identity.platform, route: "local" } : null),
                  }} />
              : <StationIdentityPage key={identity.platform} platform={identity.platform}
                  onBindingUnavailable={() => void openIdentity(identity.platform)} />
            : selected ? (
            <DetailPage
              key={selected.identity.id}
              shipment={selected}
              visibleShipments={shipments}
              persistedShipment
              accountBinding={state.bindings.find((binding) =>
                binding.source === selected.identity.bindingSource && binding.phone === selected.accountRecord?.phone)}
              attachedOrders={attachedOrders}
              refreshOnAppear={needsDetailEntryQuery(selected) ? "detail_open" : false}
              onStateChange={onStateChange}
            />
          ) : <Text>物流详情</Text>,
        }}
      >
        <RootTabList title={PICKUP_TAB_TITLE} onClose={() => dismiss()} bottomInset={TAB_FAB_SCROLL_INSET}
          titleAction={<IdentityCodeButton onOpen={openIdentity} />}
          refresh={onRefresh}
          emptyState={!sections.length ? <EmptyTabState pickup={emptyArtwork} /> : undefined}>
          {sections.map(({ key, label, items, preview }, sectionIndex) => (
            <Section key={key} header={<Text>{label}</Text>} listSectionSpacing={PICKUP_DATE_GROUP_SPACING}>
              {items.map((card, index) => cardRow(card, visible && animationReady && sectionIndex === 0 && index === 0,
                index < items.length - 1 || preview))}
              {preview ? <ParcelActivityPreviewCard animate={visible && animationReady && sectionIndex === 0 && items.length === 0}
                onComplete={() => void closePreview()} actionPending={closingPreview} /> : null}
            </Section>
          ))}
        </RootTabList>
      </VStack>
    </NavigationStack>
  );
}
