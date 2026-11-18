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
  const artwork = icon ? bundledImage(`couriers/${icon}.png`) : undefined;
  return (
    <VStack
      frame={{ width: props.size, height: props.size }}
      background={artwork ? undefined : "tertiarySystemFill"}
      clipShape={iconTileShape(props.size)}
    >
      {artwork ? (
        <Image
          image={artwork}
          resizable
          scaleToFit
          frame={{ width: props.size, height: props.size }}
        />
      ) : (
        <Image
          systemName="shippingbox.fill"
          font={Math.round(props.size * 0.5)}
          foregroundStyle="accentColor"
        />
      )}
    </VStack>
  );
}
