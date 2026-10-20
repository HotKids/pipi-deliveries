import { AbortController, Image, VStack, useEffect, useState } from "scripting";
import { loadProductImage } from "../services/product-images";
import { CourierIcon } from "./CourierIcon";

export function ProductThumbnail(props: {
  imageURL?: string;
  courierCode: string;
  companyName: string;
  accountOrder?: boolean;
  size: number;
  cornerRadius?: number;
}) {
  const imageURL = props.imageURL || "";
  const [loaded, setLoaded] = useState<{
    url: string;
    image: Awaited<ReturnType<typeof loadProductImage>>;
  } | null>(null);

  useEffect(() => {
    setLoaded(null);
    if (!imageURL) return;
    const controller = new AbortController();
    void loadProductImage(imageURL, controller.signal).then((image) => {
      if (!controller.signal.aborted) setLoaded({ url: imageURL, image });
    }).catch(() => {
      if (!controller.signal.aborted) setLoaded(null);
    });
    return () => controller.abort();
  }, [imageURL]);

  const image = loaded?.url === imageURL ? loaded.image : null;
  if (!image) {
    return (
      <CourierIcon
        courierCode={props.courierCode}
        companyName={props.companyName}
        accountOrder={props.accountOrder}
        size={props.size}
        cornerRadius={props.cornerRadius}
      />
    );
  }

  return (
    <VStack
      frame={{ width: props.size, height: props.size }}
      background="tertiarySystemFill"
      clipShape={{ type: "rect", cornerRadius: props.size * 0.25, style: "continuous" }}
    >
      <Image
        image={image}
        resizable
        scaleToFill
        frame={{ width: props.size, height: props.size }}
      />
    </VStack>
  );
}
