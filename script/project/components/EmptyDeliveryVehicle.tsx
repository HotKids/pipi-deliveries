import { Image, Text, VStack, ZStack, type VirtualNode } from "scripting";
import { bundledImage, useBundledImage } from "./bundled-image";
import { EMPTY_WIDGET_TEXT_COLOR } from "../widget/palette";

const vehicleArtwork = "widget/empty-delivery-vehicle.png";
const grapeArtwork = "widget/empty-pickup-grape.png";
const heyteaLogo = "meal-pickup/xicha.png";

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

function EmptyPickupIllustration({ size }: { size: number }) {
  const cup = useBundledImage(grapeArtwork);
  const logo = useBundledImage(heyteaLogo);
  return (
    <ZStack frame={{ width: size, height: size }}>
      {cup ? (
        <Image image={cup} renderingMode="original" resizable scaleToFit frame={{ width: size, height: size }} />
      ) : <Image systemName="cup.and.saucer" frame={{ width: size, height: size }} />}
      {cup && logo ? (
        <Image image={logo} renderingMode="original" resizable scaleToFit colorConvert
          frame={{ width: 23, height: 23 }} offset={{ x: -size * 0.01, y: size * 0.10 }} />
      ) : null}
    </ZStack>
  );
}

export function EmptyTabState({ pickup = false }: { pickup?: boolean }) {
  const size = 81.6;
  const artwork = pickup ? <EmptyPickupIllustration size={size} /> : <EmptyDeliveryVehicle size={size} deferArtwork />;
  return (
    <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }} allowsHitTesting={false}>
      <EmptyStateGroup artwork={artwork} label={pickup ? "饮咗茶未" : "暂无快递"} spacing={8} labelFont="body" />
    </VStack>
  );
}

export function EmptyDeliveryStateGroup(props: {
  vehicleSize: number;
  spacing: number;
  labelFont: number;
  deferArtwork?: boolean;
}) {
  return <EmptyStateGroup artwork={<EmptyDeliveryVehicle size={props.vehicleSize} deferArtwork={props.deferArtwork} />}
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
