import { Image, Script, VStack } from "scripting";
import { courierIconName } from "../services/carrier-presentation";
import { ICON_TILE_SHAPE } from "./icon-tile";

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
  return (
    <VStack
      frame={{ width: props.size, height: props.size }}
      background="tertiarySystemFill"
      clipShape={ICON_TILE_SHAPE}
    >
      {icon ? (
        <Image
          filePath={`${Script.directory}/assets/couriers/${icon}.png`}
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
