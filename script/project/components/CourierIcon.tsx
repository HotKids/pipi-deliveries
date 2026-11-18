import { Image, VStack } from "scripting";
import { courierIconName } from "../services/carrier-presentation";
import { bundledImage, useBundledImage } from "./bundled-image";
import { iconTileShape } from "./icon-tile";

export function CourierIcon(props: {
  courierCode: string;
  companyName: string;
  accountOrder?: boolean;
  size: number;
  deferArtwork?: boolean;
}) {
  const icon = courierIconName(
    props.courierCode,
    props.companyName,
    props.accountOrder,
  );
  const path = icon ? `couriers/${icon}.png` : undefined;
  return props.deferArtwork
    ? <DeferredCourierIcon path={path} size={props.size} />
    : <CourierIconTile artwork={path ? bundledImage(path) : undefined} size={props.size} />;
}

function DeferredCourierIcon({ path, size }: { path?: string; size: number }) {
  return <CourierIconTile artwork={useBundledImage(path)} size={size} />;
}

function CourierIconTile({ artwork, size }: { artwork?: UIImage; size: number }) {
  return (
    <VStack
      frame={{ width: size, height: size }}
      background={artwork ? undefined : "tertiarySystemFill"}
      clipShape={iconTileShape(size)}
    >
      {artwork ? (
        <Image
          image={artwork}
          resizable
          scaleToFit
          frame={{ width: size, height: size }}
        />
      ) : (
        <Image
          systemName="shippingbox.fill"
          font={Math.round(size * 0.5)}
          foregroundStyle="accentColor"
        />
      )}
    </VStack>
  );
}
