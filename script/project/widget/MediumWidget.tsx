import {
  HStack,
  Image,
  Link,
  Spacer,
  Text,
  VStack,
  ZStack,
} from "scripting";
import type { WidgetRow, WidgetSnapshot } from "../models";
import { statusTint, withNote } from "../services/status";
import { CourierIcon } from "../components/CourierIcon";
import { EmptyDeliveryStateGroup } from "../components/EmptyDeliveryVehicle";
import { mediumWidgetLayout, mediumWidgetPlacement } from "./layout";
import { WidgetLineArt } from "./WidgetLineArt";
import {
  carrierWidgetAccent,
  EMPTY_WIDGET_ACCENT,
  emptyWidgetBackground,
  mediumWidgetBackground,
} from "./palette";

/**
 * 底色跟着 statusTint 的同一个语义色走，而不是另建一张表：原先这里自带一份 switch，
 * 已下单/已发货被归进蓝色、已签收归进绿色、已取消归进红色，与统一后的状态配色（下单发货黄、
 * 签收青、取消灰）全都对不上——文字是黄的、外框却是蓝的（用户 2026-09-06 在 iOS 4×2 上发现）。
 * 这里只保留「系统色 → 同色低透明度填充」的一层映射，语义归属永远由 statusTint 决定。
 */
const STATUS_TINT_FILL: Readonly<Record<string, string>> = {
  systemOrange: "rgba(255, 149, 0, 0.15)",
  systemGreen: "rgba(52, 199, 89, 0.14)",
  systemTeal: "rgba(48, 176, 199, 0.14)",
  systemBlue: "rgba(0, 122, 255, 0.13)",
  systemYellow: "rgba(255, 204, 0, 0.20)",
  systemRed: "rgba(255, 59, 48, 0.13)",
};

function statusBadgeBackground(semantic: WidgetRow["semantic"]): string {
  return STATUS_TINT_FILL[statusTint(semantic)] || "tertiarySystemFill";
}

function Row(props: {
  row: WidgetRow;
  openURL: string;
  height: number;
  iconSize: number;
  detailFont: number;
  frameAlignment: "center" | "bottom";
  detailLineLimit: number | null;
}) {
  return (
    <Link url={props.openURL}>
      <HStack
        alignment="top"
        spacing={9}
        frame={{
          minHeight: props.height,
          maxHeight: props.height,
          maxWidth: "infinity",
          alignment: props.frameAlignment,
        }}
      >
        <CourierIcon
          courierCode={props.row.courierCode}
          companyName={props.row.companyName}
          accountOrder={props.row.accountOrder}
          size={props.iconSize}
          cornerRadius={Math.max(8, Math.round(props.iconSize * 0.26))}
        />
        <VStack alignment="leading" spacing={1} frame={{ maxWidth: "infinity" }}>
          <HStack spacing={5} frame={{ maxWidth: "infinity" }}>
            <Text font={15} fontWeight="semibold" lineLimit={1}>
              {props.row.companyName} {props.row.waybillSuffix}
            </Text>
            <Text
              font={10}
              fontWeight="medium"
              foregroundStyle={statusTint(props.row.semantic)}
              padding={{ horizontal: 5, vertical: 2 }}
              background={statusBadgeBackground(props.row.semantic)}
              clipShape={{
                type: "rect",
                cornerRadius: 6,
                style: "continuous",
              }}
              lineLimit={1}
            >
              {withNote(props.row.statusLabel, props.row.note)}
            </Text>
            <Spacer />
          </HStack>
          {props.detailLineLimit == null ? (
            <Text
              font={props.detailFont}
              foregroundStyle="secondaryLabel"
            >
              {props.row.latestDetail || "暂无物流动态"}
            </Text>
          ) : (
            <Text
              font={props.detailFont}
              foregroundStyle="secondaryLabel"
              lineLimit={props.detailLineLimit}
            >
              {props.row.latestDetail || "暂无物流动态"}
            </Text>
          )}
        </VStack>
      </HStack>
    </Link>
  );
}

export function MediumWidget(props: {
  snapshot: WidgetSnapshot;
  openHomeURL: string;
  openSearchURL: string;
  openShipmentURL: (id: string) => string;
  displayHeight: number;
}) {
  const { snapshot } = props;
  const layout = mediumWidgetLayout(props.displayHeight);
  const placement = mediumWidgetPlacement(
    props.displayHeight,
    snapshot.rows.length,
  );
  const leadingRow = snapshot.rows[0];
  const accent = leadingRow
    ? carrierWidgetAccent(
      leadingRow.courierCode,
      leadingRow.companyName,
      leadingRow.accountOrder,
    )
    : EMPTY_WIDGET_ACCENT;
  const background = leadingRow
    ? mediumWidgetBackground(
      leadingRow.courierCode,
      leadingRow.companyName,
      leadingRow.accountOrder,
    )
    : emptyWidgetBackground();
  return (
    <ZStack
      alignment="bottom"
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      widgetBackground={background}
      clipped={true}
    >
      <WidgetLineArt family="medium" />
      <VStack
        alignment="leading"
        spacing={layout.itemSpacing}
        padding={{
          horizontal: layout.horizontalPadding,
          vertical: layout.verticalPadding,
        }}
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      >
        <HStack
          frame={{ minHeight: layout.headerHeight, maxWidth: "infinity" }}
        >
          <Link url={props.openHomeURL}>
            <HStack spacing={5} frame={{ minHeight: layout.headerHeight }}>
              <Text font={15} fontWeight="semibold">我的快递</Text>
              <Text font={15} fontWeight="semibold">
                {snapshot.activeCount}
              </Text>
              <Image
                systemName="chevron.right"
                font={10}
                fontWeight="semibold"
                foregroundStyle="secondaryLabel"
              />
            </HStack>
          </Link>
          <Spacer />
          <Link url={props.openSearchURL}>
            <Image
              systemName="magnifyingglass"
              font={layout.searchFont}
              foregroundStyle={accent}
              frame={{
                width: layout.searchWidth,
                height: layout.headerHeight,
              }}
            />
          </Link>
        </HStack>
        {leadingRow ? (
          <>
            {snapshot.rows.slice(0, placement.rowCount).map((row) => (
              <Row
                key={row.shipmentId}
                row={row}
                openURL={props.openShipmentURL(row.shipmentId)}
                height={placement.rowHeight}
                iconSize={layout.iconSize}
                detailFont={layout.detailFont}
                frameAlignment={placement.rowFrameAlignment}
                detailLineLimit={placement.detailLineLimit}
              />
            ))}
          </>
        ) : (
          <Link url={props.openSearchURL}>
            <ZStack
              frame={{
                minHeight: layout.emptyContentHeight,
                maxHeight: layout.emptyContentHeight,
                maxWidth: "infinity",
                alignment: "center",
              }}
            >
              <EmptyDeliveryStateGroup
                vehicleSize={layout.emptyVehicleSize}
                spacing={layout.emptyContentSpacing}
                labelFont={layout.emptyLabelFont}
              />
            </ZStack>
          </Link>
        )}
      </VStack>
    </ZStack>
  );
}
