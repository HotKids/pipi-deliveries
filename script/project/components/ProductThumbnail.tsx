import { AbortController, Image, VStack, useEffect, useState } from "scripting";
import { initialProductImage, loadProductImage } from "../services/product-images";
import { cachedProductImage, productImageCacheKey } from "../services/product-image-cache";
import { isStoredShipmentRetained, loadState } from "../services/storage";
import type { Shipment } from "../models";
import { shipmentLifecycleKey } from "../services/shipment-lifecycle";
import { sharedData, withSharedFileTransaction } from "../services/shared-file-transaction";
import { CourierIcon } from "./CourierIcon";

export function ProductThumbnail(props: {
  shipment: Shipment;
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
  const lifecycle = shipmentLifecycleKey(props.shipment);
  let checkedStateRef: string | undefined;
  let retained = false;
  let checkedShipment = props.shipment;
  const isRetained = () => {
    if (!cacheKey) return false;
    const stateRef = sharedData().stateRef;
    if (stateRef && stateRef === checkedStateRef && (!retained || isStoredShipmentRetained(checkedShipment))) return retained;
    return withSharedFileTransaction(() => {
      const current = loadState().shipments.find(shipment => shipmentLifecycleKey(shipment) === lifecycle &&
        productImageCacheKey(shipment.identity) === cacheKey);
      retained = current != null;
      if (current) checkedShipment = current;
      checkedStateRef = sharedData().stateRef;
      return retained;
    });
  };
  const [loaded, setLoaded] = useState<{
    key: string;
    lifecycle: string;
    isRetained: () => boolean;
    image: Awaited<ReturnType<typeof loadProductImage>>;
  } | null>(() => ({ key: cacheKey, lifecycle, isRetained, image: initialProductImage(cacheKey, isRetained) }));

  useEffect(() => {
    try {
      const remembered = cachedProductImage(cacheKey);
      if (remembered && isRetained()) { setLoaded({ key: cacheKey, lifecycle, isRetained, image: remembered }); return; }
    } catch {
      // A failed authoritative read must not publish a bitmap or start an optional download.
      setLoaded(null);
      return;
    }
    if (!imageURL && !cacheKey) return;
    const controller = new AbortController();
    void loadProductImage(imageURL, controller.signal, cacheKey ? { key: cacheKey, isRetained } : undefined).then((image) => {
      if (!controller.signal.aborted && image) setLoaded({ key: cacheKey, lifecycle, isRetained, image });
    }).catch(() => { /* Keep an already successful image during an optional refresh failure. */ });
    return () => controller.abort();
  }, [cacheKey, imageURL, lifecycle]);

  let image: Awaited<ReturnType<typeof loadProductImage>> = null;
  try {
    image = loaded?.key === cacheKey && loaded.lifecycle === lifecycle && loaded.isRetained()
      ? loaded.image : initialProductImage(cacheKey, isRetained);
  } catch { /* A failed authoritative read cannot expose an unverified lifecycle's image. */ }
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
