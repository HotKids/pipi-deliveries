import { Button, HStack, Spacer, Text, VStack } from "scripting";
import type { Shipment } from "../models";
import { statusLabel, statusTint, waybillSuffix } from "../services/status";
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
  const eventTime = compactTimelineTime(item.timeline.latestTimeText);
  return (
    <HStack
      spacing={12}
      padding={{ vertical: 10 }}
      contentShape="rect"
      onTapGesture={props.onOpen}
      leadingSwipeActions={
        item.timeline.semantic === "COMPLETED"
          ? undefined
          : {
              allowsFullSwipe: false,
              actions: [
                <Button
                  title="签收"
                  tint="systemGreen"
                  action={props.onForceComplete}
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
            action={props.onDelete}
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
            foregroundStyle={statusTint(item.timeline.semantic)}
          >
            {statusLabel(item.timeline.semantic)}
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
