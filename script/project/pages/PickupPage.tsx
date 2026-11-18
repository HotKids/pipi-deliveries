import { Button, HStack, List, Navigation, NavigationStack, Section, Text, VStack, useMemo, useRef, useState } from "scripting";
import type { AppState, Shipment } from "../models";
import { ParcelActivityPreviewCard, PickupTabCard } from "../components/PickupTabCard";
import { RootPageHeader } from "../components/RootPageHeader";
import { TAB_FAB_SCROLL_INSET, TabFloatingActionButton } from "../components/TabFloatingActionButton";
import { pickupDateSections, shipmentForPickupTarget, type ParcelActivityContent, type ParcelActivityTarget } from "../services/parcel-pickup";
import { copyText } from "../services/clipboard";
import { EXPRESS_TOAST_COPY } from "../services/express-toast-copy";
import type { IdentityPlatform } from "../services/platform-accounts";
import { needsDetailEntryQuery } from "../services/shipment-policy";
import { ShipmentLifecycleChangedError } from "../services/shipment-lifecycle";
import { setPickupCardNote } from "../services/storage";
import { attachedProjectedOrders } from "../services/waybill-ownership";
import { requestWidgetReload } from "../services/widgets";
import { DetailPage } from "./DetailPage";
import { StationIdentityMark, StationIdentityPage } from "./StationIdentityPage";

const IDENTITY_CHOICES = [
  { platform: "cainiao", title: "菜鸟驿站" },
  { platform: "pinduoduo", title: "多多驿站" },
] as const;

function IdentityCodeButton({ onOpen }: {
  onOpen: (platform: IdentityPlatform) => void;
}) {
  const [showPicker, setShowPicker] = useState(false);
  return (
    <TabFloatingActionButton
      title="身份码" symbol="person.text.rectangle"
      action={() => setShowPicker(true)}
      popover={{
        isPresented: showPicker,
        onChanged: setShowPicker,
        arrowEdge: "bottom",
        presentationCompactAdaptation: "popover",
        content: (
          <VStack alignment="leading" spacing={0} padding={6} frame={{ minWidth: 196 }}>
            {IDENTITY_CHOICES.map(({ platform, title }) => (
              <Button key={platform} buttonStyle="plain" action={() => {
                setShowPicker(false);
                onOpen(platform);
              }}>
                <HStack spacing={12} padding={{ horizontal: 8, vertical: 9 }}
                  frame={{ maxWidth: "infinity", alignment: "leading" }} contentShape="rect">
                  <StationIdentityMark asset={platform} />
                  <Text font={17} foregroundStyle="label">{title}</Text>
                </HStack>
              </Button>
            ))}
          </VStack>
        ),
      }}
    />
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
  state, shipments, cards, previewing, focusedRecordId, onAction, cabinetActions, onStateChange, showNotice,
}: {
  state: AppState;
  shipments: readonly Shipment[];
  cards: readonly ParcelActivityContent[];
  previewing: boolean;
  focusedRecordId: string;
  onAction: (card: ParcelActivityContent, openCabinet: boolean) => Promise<string>;
  cabinetActions: ReadonlySet<ParcelActivityContent>;
  onStateChange: (state: AppState) => void;
  showNotice: (message: string) => void;
}) {
  const dismiss = Navigation.useDismiss();
  const [detailTarget, setDetailTarget] = useState<ParcelActivityTarget | undefined>(undefined);
  const [identity, setIdentity] = useState<IdentityPlatform | null>(null);
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
        navigationBarVisibility="hidden"
        safeAreaInset={{
          top: {
            spacing: 0,
            content: <RootPageHeader title="取件" action={() => dismiss()} />,
          },
        }}
        navigationDestination={{
          isPresented: Boolean(identity || selected),
          onChanged: (presented) => {
            if (!presented) {
              setIdentity(null);
              setDetailTarget(undefined);
            }
          },
          content: identity ? <StationIdentityPage key={identity} platform={identity} /> : selected ? (
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
        contentMargins={{ edges: "bottom", insets: TAB_FAB_SCROLL_INSET, placement: "scrollContent" }}
        overlay={{
          alignment: "bottomTrailing",
          content: <IdentityCodeButton onOpen={setIdentity} />,
        }}
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
