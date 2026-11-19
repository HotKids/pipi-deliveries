import { Image, Script, Text, VStack, ZStack, type VirtualNode } from "scripting";
import { bundledImage } from "./bundled-image";
import { EMPTY_WIDGET_TEXT_COLOR } from "../widget/palette";

const vehicleArtwork = "widget/empty-delivery-vehicle.png";
const pickupArtwork = {
  meal: { imagePath: "widget/empty-pickup-grape.png", label: "饮咗茶未" },
  parcel: { imagePath: "widget/empty-pickup-sf-box.png", label: "暂无包裹" },
};
const heyteaLogo = "meal-pickup/xicha.png";

export type PickupEmptyArtwork = keyof typeof pickupArtwork;

function EmptyDeliveryVehicle({ size }: { size: number }) {
  const artwork = bundledImage(vehicleArtwork);
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

export function EmptyTabState({ pickup }: { pickup?: PickupEmptyArtwork }) {
  const size = pickup ? 96 : 81.6;
  const frame = { width: size, height: size };
  const assetDirectory = `${Script.directory}/assets`;
  const { imagePath, label } = pickup ? pickupArtwork[pickup] : {
    imagePath: vehicleArtwork,
    label: "暂无快递",
  };
  const illustration = (
    <Image filePath={`${assetDirectory}/${imagePath}`} renderingMode="original" resizable scaleToFit frame={frame} />
  );
  const artwork = pickup === "meal" ? (
    <ZStack frame={frame}>
      {illustration}
      <Image filePath={`${assetDirectory}/${heyteaLogo}`} renderingMode="original" resizable scaleToFit colorConvert
        frame={{ width: 27, height: 27 }} offset={{ x: -size * 0.01, y: size * 0.10 }} />
    </ZStack>
  ) : illustration;
  return (
    <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }} allowsHitTesting={false}>
      <EmptyStateGroup artwork={artwork} label={label} spacing={8} labelFont="body" />
    </VStack>
  );
}

export function EmptyDeliveryStateGroup(props: {
  vehicleSize: number;
  spacing: number;
  labelFont: number;
}) {
  return <EmptyStateGroup artwork={<EmptyDeliveryVehicle size={props.vehicleSize} />}
    label="暂无快递" spacing={props.spacing} labelFont={props.labelFont} widget />;
}

function EmptyStateGroup({ artwork, label, spacing, labelFont, widget = false }: {
  artwork: VirtualNode;
  label: string;
  spacing: number;
  labelFont: "body" | number;
  widget?: boolean;
}) {
  return (
    <VStack alignment="center" spacing={spacing}>
      {artwork}
      <Text
        font={labelFont}
        fontWeight={widget ? "medium" : "regular"}
        foregroundStyle={widget ? EMPTY_WIDGET_TEXT_COLOR : "secondaryLabel"}
        lineLimit={widget ? 1 : undefined}
      >
        {label}
      </Text>
    </VStack>
  );
}
