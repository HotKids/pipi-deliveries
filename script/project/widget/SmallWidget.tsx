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
import { carrierDisplayName } from "../services/carrier-presentation";
import { EmptyDeliveryStateGroup } from "../components/EmptyDeliveryVehicle";
import {
  fitsSingleLine,
  smallWidgetEmptyLayout,
  smallWidgetLayout,
} from "./layout";
import { WidgetLineArt } from "./WidgetLineArt";
import { WidgetSenderTag } from "./WidgetSenderTag";
import {
  EMPTY_WIDGET_ACCENT,
  emptyWidgetBackground,
  mediumWidgetBackground,
} from "./palette";
import { statusTextTint } from "../services/status";

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
  const layout = smallWidgetLayout(props.displayWidth, props.displayHeight);
  const emptyLayout = smallWidgetEmptyLayout(
    props.displayWidth,
    props.displayHeight,
  );
  // 只有一行时整行居中，两行仍靠左——与 Pipi / Lite 的 compact 同一条规则（用户定 2026-09-06）。
  const detailText = row ? row.latestDetail || "暂无物流信息" : "";
  const detailFitsOneLine = fitsSingleLine(
    detailText,
    props.displayWidth - layout.outerPadding * 2,
    layout.detailFont,
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
                alignment="center"
                spacing={layout.headerSpacing}
                frame={{ maxWidth: "infinity" }}
              >
                <VStack
                  alignment="leading"
                  spacing={layout.identitySpacing}
                  frame={{
                    minHeight: layout.iconSize,
                    maxHeight: layout.iconSize,
                    maxWidth: "infinity",
                  }}
                >
                  {/* The card is titled by its status, so an outgoing parcel's small gray 寄 tag follows the
                      status word, its text at the carrier line's size (owner 2026-11-20); the status may
                      shrink a little more so the tag always fits. */}
                  <HStack alignment="center" spacing={4} frame={{ maxWidth: "infinity", alignment: "leading" }}>
                    <Text
                      font={layout.statusFont}
                      fontWeight="semibold"
                      foregroundStyle={statusTextTint(row.semantic, { label: row.statusLabel })}
                      lineLimit={1}
                      minScaleFactor={row.sender === true ? 0.75 : 0.9}
                      allowsTightening={true}
                      frame={row.sender === true ? {
                        minHeight: layout.statusLineHeight,
                        maxHeight: layout.statusLineHeight,
                        alignment: "topLeading",
                      } : {
                        minHeight: layout.statusLineHeight,
                        maxHeight: layout.statusLineHeight,
                        maxWidth: "infinity",
                        alignment: "topLeading",
                      }}
                    >
                      {row.statusLabel}
                    </Text>
                    {row.sender === true ? (
                      <WidgetSenderTag font={layout.companyFont} verticalPadding={1} />
                    ) : null}
                  </HStack>
                  <Text
                    font={layout.companyFont}
                    foregroundStyle="secondaryLabel"
                    monospacedDigit
                    lineLimit={1}
                    minScaleFactor={0.75}
                    allowsTightening={true}
                    frame={{
                      minHeight: layout.companyLineHeight,
                      maxHeight: layout.companyLineHeight,
                      maxWidth: "infinity",
                      alignment: "bottomLeading",
                    }}
                  >
                    {row.waybillSuffix
                      ? `${carrierDisplayName(row.companyName)} ${row.waybillSuffix}`
                      : carrierDisplayName(row.companyName)}
                  </Text>
                </VStack>
                <CourierIcon
                  courierCode={row.courierCode}
                  companyName={row.companyName}
                  accountOrder={row.accountOrder}
                  size={layout.iconSize}
                />
              </HStack>
              <Spacer />
              <Text
                font={layout.detailFont}
                foregroundStyle="secondaryLabel"
                lineLimit={2}
                frame={{
                  maxWidth: "infinity",
                  alignment: detailFitsOneLine ? "center" : "leading",
                }}
              >
                {detailText}
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
                monospacedDigit
                lineLimit={1}
              >
                全部快递 {snapshot.totalCount}
              </Text>
            </HStack>
          </Link>
        </VStack>
      ) : (
        <Link url={props.openSearchURL}>
          <ZStack
            frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
          >
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
            <VStack
              alignment="trailing"
              spacing={0}
              padding={{
                top: emptyLayout.searchTopPadding,
                trailing: emptyLayout.searchTrailingPadding,
              }}
              frame={{
                maxWidth: "infinity",
                maxHeight: "infinity",
                alignment: "topTrailing",
              }}
            >
              <Image
                systemName="magnifyingglass"
                font={emptyLayout.searchFont}
                foregroundStyle={EMPTY_WIDGET_ACCENT}
                frame={{
                  width: emptyLayout.searchWidth,
                  height: emptyLayout.searchHeight,
                }}
              />
              <Spacer />
            </VStack>
          </ZStack>
        </Link>
      )}
    </ZStack>
  );
}
