import { Image, VStack } from "scripting";
import { courierIconName } from "../services/carrier-presentation";
import { bundledImage } from "./bundled-image";
import { iconTileShape } from "./icon-tile";

export function CourierIcon(props: {
  courierCode: string;
  companyName: string;
  accountOrder?: boolean;
  size: number;
}) {
  const icon = courierIconName(
    props.courierCode,
    props.companyName,
    props.accountOrder,
  );
  return <CourierIconTile artwork={bundledImage(`couriers/${icon}.png`)} size={props.size} />;
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
          widgetAccentedRenderingMode="fullColor"
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
