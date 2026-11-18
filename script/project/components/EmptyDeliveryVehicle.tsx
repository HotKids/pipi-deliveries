import { Image, Text, VStack } from "scripting";
import { bundledImage, useBundledImage } from "./bundled-image";
import { EMPTY_WIDGET_TEXT_COLOR } from "../widget/palette";

const vehicleArtwork = "widget/empty-delivery-vehicle.png";

export function EmptyDeliveryVehicle({ size, deferArtwork }: { size: number; deferArtwork?: boolean }) {
  return deferArtwork ? <DeferredVehicle size={size} /> :
    <Vehicle artwork={bundledImage(vehicleArtwork)} size={size} />;
}

function DeferredVehicle({ size }: { size: number }) {
  return <Vehicle artwork={useBundledImage(vehicleArtwork)} size={size} />;
}

function Vehicle({ artwork, size }: { artwork?: UIImage; size: number }) {
  return artwork ? (
    <Image
      image={artwork}
      renderingMode="original"
      resizable={true}
      scaleToFit={true}
      frame={{ width: size, height: size }}
    />
  ) : <Image systemName="shippingbox" frame={{ width: size, height: size }} />;
}

export function EmptyDeliveryStateGroup(props: {
  vehicleSize: number;
  spacing: number;
  labelFont: number;
  deferArtwork?: boolean;
}) {
  return (
    <VStack alignment="center" spacing={props.spacing}>
      <EmptyDeliveryVehicle size={props.vehicleSize} deferArtwork={props.deferArtwork} />
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
