import { AbortController, Image, VStack, useEffect, useState } from "scripting";
import { initialProductImage, loadProductImage } from "../services/product-images";
import { cachedProductImage, cainiaoImageCacheKey, cloudProductImageCacheKey, pddImageCacheKey, productImageCacheKey } from "../services/product-image-cache";
import { pddParcelProductImage } from "../services/platform-parcel-merge";
import { currentPlatformSession } from "../services/platform-accounts";
import { gatewayCredentialForLocalCache } from "../services/credentials";
import { isStoredShipmentRetained, readAppStateSnapshot } from "../services/storage";
import type { Shipment } from "../models";
import { shipmentLifecycleKey } from "../services/shipment-lifecycle";
import { sharedData, withSharedFileTransaction } from "../services/shared-file-transaction";
import { CourierIcon } from "./CourierIcon";
import { iconTileShape } from "./icon-tile";

export function ProductThumbnail(props: {
  shipment: Shipment;
  imageURL?: string;
  cloudImage?: { url: string; scope: string };
  cacheKey: string;
  courierCode: string;
  companyName: string;
  accountOrder?: boolean;
  allowDownload?: boolean;
  size: number;
}) {
  const cainiao = !props.cacheKey ? props.shipment.platformFields?.cainiaoImage : undefined;
  const cainiaoCurrent = () => {
    try { return !!cainiao && !!currentPlatformSession("cainiao", cainiao.generation); }
    catch { return false; }
  };
  const useCainiao = cainiaoCurrent();
  const pdd = !props.cacheKey && !useCainiao && props.shipment.platformFields?.pddImage
    ? pddParcelProductImage(props.shipment) : "";
  const cloud = !props.cacheKey && !useCainiao && !pdd ? props.cloudImage : undefined;
  const cloudCurrent = () => {
    const credential = gatewayCredentialForLocalCache();
    return !!cloud && credential?.scope === cloud.scope && !credential.rejected;
  };
  const imageURL = props.imageURL || (useCainiao ? cainiao?.url : pdd || cloud?.url) || "";
  const keyFor = useCainiao ? cainiaoImageCacheKey : pdd ? pddImageCacheKey
    : cloud ? (shipment: Shipment) => cloudProductImageCacheKey(shipment, cloud.scope)
      : (shipment: Shipment) => productImageCacheKey(shipment.identity);
  const cacheKey = useCainiao || pdd || cloud ? keyFor(props.shipment) : props.cacheKey;
  const lifecycle = shipmentLifecycleKey(props.shipment);
  let checkedStateRef: string | undefined;
  let retained = false;
  let checkedShipment = props.shipment;
  const isRetained = () => {
    if (!cacheKey || useCainiao && !cainiaoCurrent() || cloud && !cloudCurrent()) return false;
    const stateRef = sharedData().stateRef;
    if (stateRef && stateRef === checkedStateRef && (!retained || isStoredShipmentRetained(checkedShipment))) return retained;
    return withSharedFileTransaction(() => {
      const current = readAppStateSnapshot().state.shipments.find(shipment =>
        shipmentLifecycleKey(shipment) === lifecycle && keyFor(shipment) === cacheKey);
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
      if (remembered && isRetained()) {
        setLoaded(current => current?.key === cacheKey && current.lifecycle === lifecycle && current.image === remembered
          ? current : { key: cacheKey, lifecycle, isRetained, image: remembered });
        return;
      }
    } catch {
      // A failed authoritative read must not publish a bitmap or start an optional download.
      setLoaded(null);
      return;
    }
    if (props.allowDownload === false || !imageURL && !cacheKey) return;
    const controller = new AbortController();
    void loadProductImage(imageURL, controller.signal, cacheKey ? { key: cacheKey, isRetained } : undefined).then((image) => {
      if (!controller.signal.aborted && image) setLoaded({ key: cacheKey, lifecycle, isRetained, image });
    }).catch(() => { /* Keep an already successful image during an optional refresh failure. */ });
    return () => controller.abort();
  }, [cacheKey, imageURL, lifecycle, props.allowDownload]);

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
      />
    );
  }

  return (
    <VStack
      frame={{ width: props.size, height: props.size }}
      background="tertiarySystemFill"
      clipShape={iconTileShape(props.size)}
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
