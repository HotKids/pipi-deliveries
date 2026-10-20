import { AbortController, Image, VStack, useEffect, useState } from "scripting";
import { initialProductImage, loadProductImage } from "../services/product-images";
import { cachedProductImage, productImageCacheKey } from "../services/product-image-cache";
import { loadState } from "../services/storage";
import { CourierIcon } from "./CourierIcon";

export function ProductThumbnail(props: {
  imageURL?: string;
  cacheKey: string;
  courierCode: string;
  companyName: string;
  accountOrder?: boolean;
  size: number;
  cornerRadius?: number;
}) {
  const imageURL = props.imageURL || "";
  const cacheKey = props.cacheKey;
  const [loaded, setLoaded] = useState<{
    key: string;
    image: Awaited<ReturnType<typeof loadProductImage>>;
  } | null>(() => ({ key: cacheKey, image: initialProductImage(cacheKey) }));

  useEffect(() => {
    const remembered = cachedProductImage(cacheKey);
    if (remembered) { setLoaded({ key: cacheKey, image: remembered }); return; }
    if (!imageURL && !cacheKey) return;
    const controller = new AbortController();
    void loadProductImage(imageURL, controller.signal, cacheKey ? { key: cacheKey,
      isRetained: () => loadState().shipments.some(shipment => productImageCacheKey(shipment.identity) === cacheKey),
    } : undefined).then((image) => {
      if (!controller.signal.aborted && image) setLoaded({ key: cacheKey, image });
    }).catch(() => { /* Keep an already successful image during an optional refresh failure. */ });
    return () => controller.abort();
  }, [cacheKey, imageURL]);

  const image = loaded?.key === cacheKey ? loaded.image : initialProductImage(cacheKey);
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
