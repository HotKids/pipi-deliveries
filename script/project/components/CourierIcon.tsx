import { Image, Script, VStack } from "scripting";
import { courierIconName } from "../services/carrier-presentation";

export function CourierIcon(props: {
  courierCode: string;
  companyName: string;
  accountOrder?: boolean;
  size: number;
  cornerRadius?: number;
}) {
  const icon = courierIconName(
    props.courierCode,
    props.companyName,
    props.accountOrder,
  );
  const radius = props.cornerRadius ?? Math.max(8, Math.round(props.size * 0.24));
  return (
    <VStack
      frame={{ width: props.size, height: props.size }}
      background="tertiarySystemFill"
      clipShape={{ type: "rect", cornerRadius: radius, style: "continuous" }}
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
