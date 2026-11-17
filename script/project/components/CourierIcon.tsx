import { Image, Script, VStack } from "scripting";
import { courierIconName } from "../services/carrier-presentation";
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
  return (
    <VStack
      frame={{ width: props.size, height: props.size }}
      background={icon ? undefined : "tertiarySystemFill"}
      clipShape={iconTileShape(props.size)}
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
