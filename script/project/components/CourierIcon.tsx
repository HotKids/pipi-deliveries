import { Image, Script, VStack } from "scripting";
import { courierIconName } from "../services/carrier-presentation";
import { iconTileShape } from "./icon-tile";

const images = new Map<string, UIImage>();

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
  let artwork = icon ? images.get(icon) : undefined;
  if (icon && !artwork) {
    artwork = UIImage.fromFile(`${Script.directory}/assets/couriers/${icon}.png`) ?? undefined;
    if (artwork) images.set(icon, artwork);
  }
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
