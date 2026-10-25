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
import { withNote } from "../services/status";
import { CourierIcon } from "../components/CourierIcon";
import { carrierDisplayName } from "../services/carrier-presentation";
import { EmptyDeliveryStateGroup } from "../components/EmptyDeliveryVehicle";
import { mediumWidgetLayout, mediumWidgetPlacement } from "./layout";
import { WidgetLineArt } from "./WidgetLineArt";
import {
  carrierWidgetAccent,
  EMPTY_WIDGET_ACCENT,
  emptyWidgetBackground,
  mediumWidgetBackground,
  widgetStatusStyle,
} from "./palette";

function Row(props: {
  row: WidgetRow;
  openURL: string;
  height: number;
  iconSize: number;
  detailFont: number;
  frameAlignment: "center" | "bottom";
  detailLineLimit: number | null;
}) {
  const statusStyle = widgetStatusStyle(props.row.semantic);
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
          <HStack spacing={6} frame={{ maxWidth: "infinity" }}>
            <Text font={15} fontWeight="semibold" lineLimit={1}>
              {carrierDisplayName(props.row.companyName)} {props.row.waybillSuffix}
            </Text>
            <Text
              font={11}
              fontWeight="medium"
              foregroundStyle={statusStyle.foreground}
              padding={{ horizontal: 5, vertical: 2 }}
              background={statusStyle.background}
              clipShape={{
                type: "rect",
                cornerRadius: 3,
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
              {props.row.latestDetail || "暂无物流信息"}
            </Text>
          ) : (
            <Text
              font={props.detailFont}
              foregroundStyle="secondaryLabel"
              lineLimit={props.detailLineLimit}
            >
              {props.row.latestDetail || "暂无物流信息"}
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
            <HStack
              alignment="center"
              spacing={5}
              foregroundStyle="label"
              frame={{ minHeight: layout.headerHeight }}
            >
              <Text font={15} fontWeight="semibold">我的快递</Text>
              <HStack alignment="center" spacing={4}>
                <Text font={15} fontWeight="semibold">
                  {snapshot.activeCount}
                </Text>
                <Image
                  systemName="chevron.right"
                  font={15}
                  fontWeight="semibold"
                />
              </HStack>
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
