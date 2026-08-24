import {
  HStack,
  Image,
  Link,
  Spacer,
  Text,
  VStack,
  ZStack,
} from "scripting";
import type { WidgetSnapshot } from "../models";
import { CourierIcon } from "../components/CourierIcon";
import { EmptyDeliveryStateGroup } from "../components/EmptyDeliveryVehicle";
import { smallWidgetEmptyLayout, smallWidgetLayout } from "./layout";
import { WidgetLineArt } from "./WidgetLineArt";
import {
  EMPTY_WIDGET_ACCENT,
  emptyWidgetBackground,
  mediumWidgetBackground,
} from "./palette";

export function SmallWidget(props: {
  snapshot: WidgetSnapshot;
  openHomeURL: string;
  openSearchURL: string;
  openShipmentURL: (id: string) => string;
  displayWidth: number;
  displayHeight: number;
}) {
  const { snapshot } = props;
  const row = snapshot.rows[0];
  const layout = smallWidgetLayout(props.displayWidth);
  const emptyLayout = smallWidgetEmptyLayout(
    props.displayWidth,
    props.displayHeight,
  );
  const background = row
    ? mediumWidgetBackground(
      row.courierCode,
      row.companyName,
      row.accountOrder,
    )
    : emptyWidgetBackground();
  return (
    <ZStack
      alignment="bottom"
      frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
      widgetBackground={background}
      clipped={true}
    >
      <WidgetLineArt family="small" />
      {row ? (
        <VStack
          alignment="leading"
          spacing={6}
          padding={layout.outerPadding}
          frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
        >
          <Link url={props.openShipmentURL(row.shipmentId)}>
            <VStack
              alignment="leading"
              spacing={0}
              frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
            >
              <HStack
                alignment="top"
                spacing={layout.headerSpacing}
                frame={{ maxWidth: "infinity" }}
              >
                <Text
                  font={layout.statusFont}
                  fontWeight="semibold"
                  lineLimit={1}
                  minScaleFactor={0.9}
                  allowsTightening={true}
                  frame={{ maxWidth: "infinity", alignment: "leading" }}
                >
                  {row.statusLabel}
                </Text>
                <CourierIcon
                  courierCode={row.courierCode}
                  companyName={row.companyName}
                  accountOrder={row.accountOrder}
                  size={layout.iconSize}
                  cornerRadius={Math.max(8, Math.round(layout.iconSize * 0.28))}
                />
              </HStack>
              <Spacer />
              <Text
                font={layout.detailFont}
                foregroundStyle="secondaryLabel"
                lineLimit={2}
                frame={{ maxWidth: "infinity", alignment: "leading" }}
              >
                {row.latestDetail || "暂无物流动态"}
              </Text>
              <Spacer />
            </VStack>
          </Link>
          <Link url={props.openHomeURL}>
            <HStack
              spacing={layout.pillSpacing}
              padding={{ horizontal: layout.pillHorizontalPadding }}
              frame={{
                minHeight: layout.pillHeight,
                maxHeight: layout.pillHeight,
                maxWidth: "infinity",
                alignment: "center",
              }}
              background={{
                light: "black",
                dark: "rgba(72, 72, 74, 1)",
              }}
              clipShape={{
                type: "rect",
                cornerRadius: Math.round(layout.pillHeight / 2),
                style: "continuous",
              }}
            >
              <Image
                systemName="shippingbox.fill"
                font={layout.pillIconFont}
                foregroundStyle="white"
              />
              <Text
                font={layout.pillFont}
                fontWeight="semibold"
                foregroundStyle="white"
                lineLimit={1}
              >
                全部快递 {snapshot.totalCount}
              </Text>
            </HStack>
          </Link>
        </VStack>
      ) : (
        <Link url={props.openSearchURL}>
          <VStack
            spacing={0}
            padding={emptyLayout.padding}
            frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
          >
            <HStack
              frame={{
                maxWidth: "infinity",
                minHeight: emptyLayout.headerHeight,
                maxHeight: emptyLayout.headerHeight,
              }}
            >
              <Spacer />
              <Image
                systemName="magnifyingglass"
                font={emptyLayout.searchFont}
                foregroundStyle={EMPTY_WIDGET_ACCENT}
                frame={{
                  width: emptyLayout.searchSize,
                  height: emptyLayout.searchSize,
                }}
              />
            </HStack>
            <ZStack
              frame={{
                minHeight: emptyLayout.contentHeight,
                maxHeight: emptyLayout.contentHeight,
                maxWidth: "infinity",
                alignment: "center",
              }}
            >
              <EmptyDeliveryStateGroup
                vehicleSize={emptyLayout.vehicleSize}
                spacing={emptyLayout.contentSpacing}
                labelFont={emptyLayout.labelFont}
              />
            </ZStack>
          </VStack>
        </Link>
      )}
    </ZStack>
  );
}
