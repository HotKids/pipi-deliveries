import { Image, Script, Text, VStack } from "scripting";
import { EMPTY_WIDGET_TEXT_COLOR } from "../widget/palette";

export function EmptyDeliveryVehicle(props: { size: number }) {
  return (
    <Image
      filePath={`${Script.directory}/assets/widget/empty-delivery-vehicle.png`}
      renderingMode="original"
      resizable={true}
      scaleToFit={true}
      frame={{ width: props.size, height: props.size }}
    />
  );
}

export function EmptyDeliveryStateGroup(props: {
  vehicleSize: number;
  spacing: number;
  labelFont: number;
}) {
  return (
    <VStack alignment="center" spacing={props.spacing}>
      <EmptyDeliveryVehicle size={props.vehicleSize} />
      <Text
        font={props.labelFont}
        fontWeight="medium"
        foregroundStyle={EMPTY_WIDGET_TEXT_COLOR}
        lineLimit={1}
      >
        暂无快递
      </Text>
    </VStack>
  );
}
