import { Button, HStack, Navigation, NavigationStack, QRImage, Section, Text, VStack, useEffect, useMemo, useRef, useState } from "scripting";
import type { AppState, Shipment } from "../models";
import { ParcelActivityPreviewCard, PickupTabCard } from "../components/PickupTabCard";
import { RootTabList } from "../components/RootPageHeader";
import { TAB_FAB_DIAMETER, TAB_FAB_PADDING, TAB_FAB_SCROLL_INSET, TabFloatingActionButton } from "../components/TabFloatingActionButton";
import { PICKUP_TAB_TITLE, pickupDateSections, shipmentForPickupTarget, type ParcelActivityContent, type ParcelActivityTarget } from "../services/parcel-pickup";
import { copyText } from "../services/clipboard";
import { EXPRESS_TOAST_COPY } from "../services/express-toast-copy";
import { accountStatus, onPlatformAccountsChanged, type IdentityPlatform } from "../services/platform-accounts";
import { stationIdentityDestination } from "../services/platform-wire";
import { needsDetailEntryQuery } from "../services/shipment-policy";
import { ShipmentLifecycleChangedError } from "../services/shipment-lifecycle";
import { mealRedemption } from "../services/meal/cards";
import { currentMeal, readMeals } from "../services/meal/records";
import { mealCredentialScope } from "../services/meal/rules";
import { parcelCardKey, setPickupCardNote } from "../services/storage";
import { attachedProjectedOrders } from "../services/waybill-ownership";
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
    <VStack padding={TAB_FAB_PADDING}>
      <HStack spacing={0} popover={{
        isPresented: showPicker,
        onChanged: setShowPicker,
        arrowEdge: "bottom",
        presentationCompactAdaptation: "popover",
        content: (
          <VStack alignment="leading" spacing={0} padding={6} fixedSize={{ horizontal: true, vertical: false }}>
            {IDENTITY_CHOICES.map(({ platform, title }) => (
              <Button key={platform} buttonStyle="plain" frame={{ maxWidth: "infinity", alignment: "leading" }}
                contentShape="rect" action={() => {
                  setShowPicker(false);
                  onOpen(platform);
                }}>
                <HStack spacing={12} padding={{ horizontal: 8, vertical: 9 }}
                  frame={{ maxWidth: "infinity", alignment: "leading" }}>
                  <StationIdentityMark asset={platform} />
                  <Text font={17} foregroundStyle="label">{title}</Text>
                </HStack>
              </Button>
            ))}
          </VStack>
        ),
      }}>
        <VStack frame={{ width: 44, height: TAB_FAB_DIAMETER }} />
        <TabFloatingActionButton title="身份码" symbol="person.text.rectangle"
          action={() => setShowPicker(!showPicker)} />
      </HStack>
    </VStack>
  );
}

function PickupCardRow({ card, animate, spaceAfter, note, opensCabinet, actionBlocked, onDetail, onSaveNote, onAction, showNotice, onMealCode }: {
  card: ParcelActivityContent;
  animate: boolean;
  spaceAfter: boolean;
  note: string;
  opensCabinet: boolean;
  actionBlocked: boolean;
  onDetail?: () => void;
  onSaveNote?: (note: string) => void;
  onAction: (card: ParcelActivityContent, openCabinet: boolean) => Promise<string>;
  showNotice: (message: string) => void;
  onMealCode?: () => void;
}) {
  const [showAddress, setShowAddress] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const acting = useRef(false);
  const editing = useRef(false);
  const canSwitch = Boolean(card.kind !== "handoff" && card.address && card.location && card.location !== card.address);

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
      showNotice(value.trim() ? EXPRESS_TOAST_COPY.userNoteSaved : EXPRESS_TOAST_COPY.userNoteDeleted);
    } catch (error) {
      showNotice(error instanceof ShipmentLifecycleChangedError
        ? EXPRESS_TOAST_COPY.userNoteChanged : EXPRESS_TOAST_COPY.userNoteUnavailable);
    } finally {
      editing.current = false;
    }
  }

  async function complete() {
    if (acting.current || actionBlocked) return;
    acting.current = true;
    setActionPending(true);
    try {
      const notice = await onAction(card, opensCabinet);
      if (notice) showNotice(notice);
    } catch {
      showNotice(card.kind === "meal" ? "取餐状态更新失败，请重试" : EXPRESS_TOAST_COPY.signFailed);
    } finally {
      acting.current = false;
      setActionPending(false);
    }
  }

  return (
    <PickupTabCard
      data={card}
      animate={animate}
      spaceAfter={spaceAfter}
      title={note || card.title}
      onCopy={onMealCode ?? (() => void copyText(card.code).then((result) => showNotice(result === "copied"
        ? (card.kind === "meal" ? "取餐码已复制" : card.kind === "handoff" ? "寄件码已复制" : "取件码已复制")
        : EXPRESS_TOAST_COPY.copyFailed)))}
      onDetail={onDetail}
      onEditNote={card.target && onSaveNote ? () => void editNote() : undefined}
      actionLabel={opensCabinet ? "一键开柜" : undefined}
      actionPending={actionPending || actionBlocked}
      locationText={canSwitch && showAddress ? card.address : card.location}
      showingAddress={canSwitch && showAddress}
      onLocationTap={canSwitch ? () => setShowAddress(!showAddress) : undefined}
      onComplete={card.target ? () => void complete() : undefined}
    />
  );
}

export function PickupPage({
  state, shipments, cards, previewing, focusedRecordId, onAction, onStateChange, showNotice,
}: {
  state: AppState;
  shipments: readonly Shipment[];
  cards: readonly ParcelActivityContent[];
  previewing: boolean;
  focusedRecordId: string;
  onAction: (card: ParcelActivityContent, openCabinet: boolean) => Promise<string>;
  onStateChange: (state: AppState) => void;
  showNotice: (message: string) => void;
}) {
  const dismiss = Navigation.useDismiss();
  const [mealQr, setMealQr] = useState<{ id: string; scope: string } | null>(null);
  const [detailTarget, setDetailTarget] = useState<ParcelActivityTarget | undefined>(undefined);
  const [identity, setIdentity] = useState<PickupIdentityDestination | null>(null);
  const identityRequest = useRef(0);
  const [visible, setVisible] = useState(false);
  const [cabinetRevision, setCabinetRevision] = useState(0);
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
  const sections = pickupDateSections(cards, previewing, focusedRecordId);
  const shownQr = mealQr && cards.some(card => card.target && "mealId" in card.target &&
    card.target.mealId === mealQr.id && card.target.mealScope === mealQr.scope) && mealCredentialScope() === mealQr.scope
    ? currentMeal(readMeals(mealQr.scope), mealQr.id) : undefined;
  const qrPayload = shownQr ? mealRedemption(shownQr) : "";

  async function openIdentity(platform: IdentityPlatform) {
    const request = ++identityRequest.current;
    const route = await stationIdentityDestination(platform, (url) => Safari.openURL(url));
    if (request !== identityRequest.current) return;
    setIdentity(route === "login" ? { platform, route, generation: accountStatus(platform).generation }
      : route === "local" ? { platform, route } : null);
  }

  function cardRow(card: ParcelActivityContent, animate: boolean, spaceAfter: boolean) {
    const target = card.target;
    const key = parcelCardKey(card);
    if (target && "mealId" in target) return <PickupCardRow key={key} card={card} animate={animate} spaceAfter={spaceAfter} note=""
      opensCabinet={false} actionBlocked={false} onAction={onAction} showNotice={showNotice}
      onMealCode={card.hasMealQR ? () => setMealQr({ id: target.mealId, scope: target.mealScope }) : undefined} />;
    const shipment = shipmentForPickupTarget(shipments, target);
    const note = (target && "recordId" in target
      ? records?.find((record) => record.id === target.recordId)?.note : shipment?.note) || "";
    return (
      <PickupCardRow key={key} card={card} animate={animate} spaceAfter={spaceAfter}
        note={note} opensCabinet={Boolean(cabinetActions?.has(card))}
        actionBlocked={card.platform === "fengchao" && !cabinetActions} onAction={onAction}
        showNotice={showNotice} onDetail={shipment ? () => {
          identityRequest.current++;
          setDetailTarget(target);
        } : undefined}
        onSaveNote={(value) => {
          onStateChange(setPickupCardNote(card, note, value));
          if (shipment) requestWidgetReload();
        }} />
    );
  }

  return (
    <NavigationStack>
      <VStack navigationBarVisibility="hidden" spacing={0}
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
        onAppear={() => setVisible(true)}
        onDisappear={() => setVisible(false)}
        overlay={{ alignment: "bottomTrailing", content: <IdentityCodeButton onOpen={openIdentity} /> }}
        sheet={{
          isPresented: Boolean(qrPayload),
          onChanged: shown => { if (!shown) setMealQr(null); },
          content: qrPayload ? <VStack spacing={20} padding={24} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
            <Text font="headline">取餐二维码</Text>
            <VStack padding={16} background={{ style: "white", shape: { type: "rect", cornerRadius: 16 } }}>
              <QRImage data={qrPayload} size={200} />
            </VStack>
            <Button title="关闭" action={() => setMealQr(null)} />
          </VStack> : <VStack />,
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
        <RootTabList title={PICKUP_TAB_TITLE} onClose={() => dismiss()} bottomInset={TAB_FAB_SCROLL_INSET}>
          {sections.map(({ key, label, items, preview }, sectionIndex) => (
            <Section key={key} header={<Text>{label}</Text>}>
              {items.map((card, index) => cardRow(card, sectionIndex === 0 && index === 0,
                index < items.length - 1 || preview))}
              {preview ? <ParcelActivityPreviewCard animate={sectionIndex === 0 && items.length === 0} /> : null}
            </Section>
          ))}
        </RootTabList>
      </VStack>
    </NavigationStack>
  );
}
