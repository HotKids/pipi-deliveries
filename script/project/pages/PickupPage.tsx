import { Button, HStack, Image, List, Navigation, NavigationStack, Section, Text, VStack, useMemo, useRef, useState } from "scripting";
import type { AppState, PickupPlatform, Shipment } from "../models";
import { ParcelActivityPreviewCard, PickupTabCard } from "../components/PickupTabCard";
import { pickupDateSections, shipmentForPickupTarget, type ParcelActivityContent, type ParcelActivityTarget } from "../services/parcel-pickup";
import { copyText } from "../services/clipboard";
import { EXPRESS_TOAST_COPY } from "../services/express-toast-copy";
import { needsDetailEntryQuery } from "../services/shipment-policy";
import { ShipmentLifecycleChangedError } from "../services/shipment-lifecycle";
import { setPickupCardNote } from "../services/storage";
import { attachedProjectedOrders } from "../services/waybill-ownership";
import { requestWidgetReload } from "../services/widgets";
import { DetailPage } from "./DetailPage";
import { IDENTITY_STATION_NAMES, StationIdentityMark } from "./StationIdentityPage";

type IdentityCodeAction = Readonly<{
  platform: Extract<PickupPlatform, "cainiao" | "pinduoduo">;
  open: () => void | Promise<void>;
}>;

const IDENTITY_DIAMETER = 56;
const IDENTITY_INSET = 20;
const IDENTITY_BACKGROUND = { light: "#9EF0FC", dark: "#004F57" } as const;
const IDENTITY_FOREGROUND = { light: "#004F57", dark: "#9EF0FC" } as const;

function IdentityCodeButton({ actions, onOpen }: {
  actions: readonly IdentityCodeAction[];
  onOpen: (action: IdentityCodeAction) => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  return (
    <Button
      buttonStyle="plain"
      action={() => actions.length === 1 ? onOpen(actions[0]) : setShowPicker(true)}
      popover={actions.length > 1 ? {
        isPresented: showPicker,
        onChanged: setShowPicker,
        arrowEdge: "bottom",
        presentationCompactAdaptation: "popover",
        content: (
          <VStack alignment="leading" spacing={0} padding={6} frame={{ minWidth: 196 }}>
            {actions.map(({ platform, open }) => (
              <Button key={platform} buttonStyle="plain" action={() => {
                setShowPicker(false);
                onOpen({ platform, open });
              }}>
                <HStack spacing={12} padding={{ horizontal: 8, vertical: 9 }}
                  frame={{ maxWidth: "infinity", alignment: "leading" }} contentShape="rect">
                  <StationIdentityMark platform={platform} />
                  <Text font={17} foregroundStyle="label">{IDENTITY_STATION_NAMES[platform]}</Text>
                </HStack>
              </Button>
            ))}
          </VStack>
        ),
      } : undefined}
    >
      <VStack
        spacing={1}
        frame={{ width: IDENTITY_DIAMETER, height: IDENTITY_DIAMETER }}
        background={{ style: IDENTITY_BACKGROUND, shape: "circle" }}
        shadow={{ color: "rgba(0,0,0,0.15)", radius: 12, x: 0, y: 4 }}
        contentShape="circle"
      >
        <Image systemName="person.text.rectangle" font={24} fontWeight="semibold" foregroundStyle={IDENTITY_FOREGROUND} />
        <Text font={9} fontWeight="medium" foregroundStyle={IDENTITY_FOREGROUND}>身份码</Text>
      </VStack>
    </Button>
  );
}

function PickupCardRow({ card, note, opensCabinet, onDetail, onSaveNote, onAction, showNotice }: {
  card: ParcelActivityContent;
  note: string;
  opensCabinet: boolean;
  onDetail?: () => void;
  onSaveNote: (note: string) => void;
  onAction: (card: ParcelActivityContent, openCabinet: boolean) => Promise<string>;
  showNotice: (message: string) => void;
}) {
  const [showAddress, setShowAddress] = useState(false);
  const [actionPending, setActionPending] = useState(false);
  const acting = useRef(false);
  const editing = useRef(false);
  const canSwitch = Boolean(card.kind !== "handoff" && card.address && card.location && card.location !== card.address);

  async function editNote() {
    if (editing.current) return;
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
    if (acting.current) return;
    acting.current = true;
    setActionPending(true);
    try {
      const notice = await onAction(card, opensCabinet);
      if (notice) showNotice(notice);
    } catch {
      showNotice(EXPRESS_TOAST_COPY.signFailed);
    } finally {
      acting.current = false;
      setActionPending(false);
    }
  }

  return (
    <PickupTabCard
      data={card}
      title={note || card.title}
      onCopy={() => void copyText(card.code).then((result) => showNotice(result === "copied"
        ? (card.kind === "handoff" ? "寄件码已复制" : "取件码已复制") : EXPRESS_TOAST_COPY.copyFailed))}
      onDetail={onDetail}
      onEditNote={card.target ? () => void editNote() : undefined}
      actionLabel={opensCabinet ? "一键开柜" : undefined}
      actionPending={actionPending}
      locationText={canSwitch && showAddress ? card.address : card.location}
      showingAddress={canSwitch && showAddress}
      onLocationTap={canSwitch ? () => setShowAddress(!showAddress) : undefined}
      onComplete={card.target ? () => void complete() : undefined}
    />
  );
}

export function PickupPage({
  state, shipments, cards, previewing, focusedRecordId, onAction, cabinetActions, identityActions = [], onStateChange, showNotice,
}: {
  state: AppState;
  shipments: readonly Shipment[];
  cards: readonly ParcelActivityContent[];
  previewing: boolean;
  focusedRecordId: string;
  onAction: (card: ParcelActivityContent, openCabinet: boolean) => Promise<string>;
  cabinetActions: ReadonlySet<ParcelActivityContent>;
  identityActions?: readonly IdentityCodeAction[];
  onStateChange: (state: AppState) => void;
  showNotice: (message: string) => void;
}) {
  const dismiss = Navigation.useDismiss();
  const [detailTarget, setDetailTarget] = useState<ParcelActivityTarget | undefined>(undefined);
  const selected = shipmentForPickupTarget(shipments, detailTarget);
  const attachedOrders = useMemo(() => selected ? attachedProjectedOrders(state.shipments, selected) : undefined,
    [state.shipments, selected]);
  const records = state.pickupCodeRecords;
  const sections = pickupDateSections(cards, previewing, focusedRecordId);

  function cardRow(card: ParcelActivityContent) {
    const target = card.target;
    const key = target && ("shipmentId" in target ? "shipment:" + target.shipmentId + ":" + target.waybillGeneration : "pickup:" + target.recordId);
    const shipment = shipmentForPickupTarget(shipments, target);
    const note = (target && "recordId" in target
      ? records?.find((record) => record.id === target.recordId)?.note : shipment?.note) || "";
    return (
      <PickupCardRow key={key} card={card} note={note} opensCabinet={cabinetActions.has(card)} onAction={onAction}
        showNotice={showNotice} onDetail={shipment ? () => setDetailTarget(target) : undefined}
        onSaveNote={(value) => {
          onStateChange(setPickupCardNote(card, note, value));
          if (shipment) requestWidgetReload();
        }} />
    );
  }

  return (
    <NavigationStack>
      <List
        navigationTitle="取件"
        navigationBarTitleDisplayMode="large"
        toolbar={{
          topBarLeading: (
            <Button buttonStyle="plain" action={() => dismiss()}>
              <Image systemName="chevron.left" font={17} frame={{ width: 44, height: 44 }} />
            </Button>
          ),
        }}
        navigationDestination={{
          isPresented: Boolean(selected),
          onChanged: (presented) => { if (!presented) setDetailTarget(undefined); },
          content: selected ? (
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
        contentMargins={identityActions.length
          ? { edges: "bottom", insets: IDENTITY_DIAMETER + IDENTITY_INSET, placement: "scrollContent" }
          : undefined}
        overlay={identityActions.length ? {
          alignment: "bottomTrailing",
          content: (
            <VStack padding={{ trailing: IDENTITY_INSET, bottom: IDENTITY_INSET }}>
              <IdentityCodeButton actions={identityActions} onOpen={(action) => {
                void Promise.resolve().then(action.open).catch(() => showNotice("身份码暂时不可用，请重试。"));
              }} />
            </VStack>
          ),
        } : undefined}
      >
        {sections.map(({ key, label, items, preview }) => (
          <Section key={key} header={<Text>{label}</Text>}>
            {items.map(cardRow)}
            {preview ? <ParcelActivityPreviewCard animate /> : null}
          </Section>
        ))}
      </List>
    </NavigationStack>
  );
}
