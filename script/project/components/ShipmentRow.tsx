import { Button, HStack, Spacer, Text, VStack, useState } from "scripting";
import type { Shipment } from "../models";
import {
  shipmentPresentationStatus,
  statusTint,
  waybillSuffix,
} from "../services/status";
import {
  displayWaybill,
  unprojectedAccountOrder,
} from "../services/shipment-policy";
import { compactTimelineTime } from "../services/time-presentation";
import { CourierIcon } from "./CourierIcon";

export function ShipmentRow(props: {
  shipment: Shipment;
  onOpen: () => void;
  onDelete: () => void;
  onForceComplete: () => void;
}) {
  const item = props.shipment;
  const [pendingAction, setPendingAction] = useState<
    "delete" | "complete" | null
  >(null);
  const presentationStatus = shipmentPresentationStatus(item);
  const eventTime = compactTimelineTime(item.timeline.latestTimeText);

  function confirmPendingAction() {
    const action = pendingAction;
    if (!action) return;
    setPendingAction(null);
    setTimeout(() => {
      if (action === "delete") props.onDelete();
      else props.onForceComplete();
    }, 350);
  }

  return (
    <HStack
      spacing={12}
      padding={{ vertical: 10 }}
      contentShape="rect"
      onTapGesture={props.onOpen}
      confirmationDialog={{
        title: pendingAction === "delete" ? "删除快递" : "标记为已签收",
        isPresented: pendingAction != null,
        onChanged: (presented) => {
          if (!presented) setPendingAction(null);
        },
        message: (
          <Text>
            {pendingAction === "delete"
              ? "删除后，该快递及其本地物流轨迹将一并移除。"
              : "确认将该快递标记为已签收？"}
          </Text>
        ),
        actions: (
          <Button
            title={pendingAction === "delete" ? "删除" : "签收"}
            role={pendingAction === "delete" ? "destructive" : "confirm"}
            action={confirmPendingAction}
          />
        ),
      }}
      leadingSwipeActions={
        item.timeline.semantic === "COMPLETED"
          ? undefined
          : {
              allowsFullSwipe: false,
              actions: [
                <Button
                  title="签收"
                  tint="systemGreen"
                  action={() => setPendingAction("complete")}
                />,
              ],
            }
      }
      trailingSwipeActions={{
        allowsFullSwipe: false,
        actions: [
          <Button
            title="删除"
            role="destructive"
            action={() => setPendingAction("delete")}
          />,
        ],
      }}
    >
      <CourierIcon
        courierCode={item.identity.courierCode}
        companyName={item.identity.companyName}
        accountOrder={Boolean(
          unprojectedAccountOrder(item),
        )}
        size={48}
        cornerRadius={11}
      />
      <VStack alignment="leading" spacing={4} frame={{ maxWidth: "infinity" }}>
        <HStack spacing={8}>
          <Text
            font={17}
            fontWeight="semibold"
            foregroundStyle={statusTint(presentationStatus.semantic)}
          >
            {presentationStatus.text}
          </Text>
          <Spacer />
          {eventTime ? (
            <Text font={12} foregroundStyle="secondaryLabel" monospacedDigit>
              {eventTime}
            </Text>
          ) : null}
        </HStack>
        <HStack spacing={7}>
          <Text font={14} fontWeight="medium" lineLimit={1}>
            {item.identity.companyName}
          </Text>
          <Text font={14} foregroundStyle="secondaryLabel" monospacedDigit>
            {waybillSuffix(displayWaybill(item))}
          </Text>
          <Spacer />
        </HStack>
        <Text font={14} foregroundStyle="secondaryLabel" lineLimit={2}>
          {item.timeline.latestDetail || "暂无物流动态"}
        </Text>
      </VStack>
    </HStack>
  );
}
