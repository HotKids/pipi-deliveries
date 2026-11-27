import { AbortController, Image, VStack, useEffect, useState } from "scripting";
import { initialProductImage, loadProductImage, warmCachedProductImage } from "../services/product-images";
import { cachedProductImage, cainiaoImageCacheKey, cloudProductImageCacheKey, pddImageCacheKey, productImageCacheKey } from "../services/product-image-cache";
import { pddParcelProductImage } from "../services/platform-parcel-merge";
import { currentPlatformSessionInTurn } from "../services/platform-accounts";
import { gatewayCredentialForLocalCache } from "../services/credentials";
import { isStoredShipmentRetained, readAppStateSnapshot } from "../services/storage";
import type { Shipment } from "../models";
import { shipmentLifecycleKey } from "../services/shipment-lifecycle";
import { sharedData, withSharedFileTransaction } from "../services/shared-file-transaction";
import { CourierIcon } from "./CourierIcon";
import { iconTileShape } from "./icon-tile";

// Thumbnails checking one committed state version share its stored shipments, grouped by lifecycle in
// stored order. A new state version, or a found owner that retention no longer keeps, rebuilds it once.
type OwnerIndex = Readonly<{ stateRef: string | undefined; byLifecycle: ReadonlyMap<string, readonly Shipment[]> }>;
let ownerIndex: OwnerIndex | undefined;

function rebuildOwnerIndex(): OwnerIndex {
  // The shipments and their state reference come from the same shared-file generation.
  return withSharedFileTransaction(() => {
    const byLifecycle = new Map<string, Shipment[]>();
    for (const shipment of readAppStateSnapshot().state.shipments) {
      const lifecycleKey = shipmentLifecycleKey(shipment);
      const owners = byLifecycle.get(lifecycleKey);
      if (owners) owners.push(shipment);
      else byLifecycle.set(lifecycleKey, [shipment]);
    }
    return ownerIndex = { stateRef: sharedData().stateRef, byLifecycle };
  });
}

/** The first stored shipment with this lifecycle and image key, as a scan of the stored state finds it. */
function storedImageOwner(lifecycle: string, cacheKey: string, keyFor: (shipment: Shipment) => string): Shipment | undefined {
  const find = (index: OwnerIndex) => index.byLifecycle.get(lifecycle)?.find(shipment => keyFor(shipment) === cacheKey);
  const stateRef = sharedData().stateRef;
  const index = ownerIndex;
  if (stateRef && index && stateRef === index.stateRef) {
    const owner = find(index);
    if (!owner || isStoredShipmentRetained(owner)) return owner;
  }
  return find(rebuildOwnerIndex());
}

export function ProductThumbnail(props: {
  shipment: Shipment;
  imageURL?: string;
  cloudImage?: { url: string; scope: string };
  cacheKey: string;
  courierCode: string;
  companyName: string;
  accountOrder?: boolean;
  allowDownload?: boolean;
  /** When true, first paint uses only already-decoded in-memory images and defers disk/Keychain reads until post-paint. */
  deferDiskDecode?: boolean;
  size: number;
}) {
  const cainiao = !props.cacheKey ? props.shipment.platformFields?.cainiaoImage : undefined;
  const deferDisk = props.deferDiskDecode === true;
  const cainiaoCurrent = () => {
    try { return !!cainiao && !!currentPlatformSessionInTurn("cainiao", cainiao.generation, true); }
    catch { return false; }
  };
  const useCainiao = deferDisk ? Boolean(cainiao?.url) : cainiaoCurrent();
  const pdd = !props.cacheKey && !useCainiao && props.shipment.platformFields?.pddImage
    ? pddParcelProductImage(props.shipment) : "";
  const cloud = !props.cacheKey && !useCainiao && !pdd ? props.cloudImage : undefined;
  const cloudCurrent = () => {
    const credential = gatewayCredentialForLocalCache();
    return !!cloud && credential?.scope === cloud.scope && !credential.rejected;
  };
  const imageURL = props.imageURL || (useCainiao ? cainiao?.url : pdd || cloud?.url) || "";
  const keyFor = useCainiao ? cainiaoImageCacheKey : pdd ? pddImageCacheKey
    // R5-NEW-09 ①: the cloud image's own URL is part of its key, so a replaced cloud image is not served from the old one.
    : cloud ? (shipment: Shipment) => cloudProductImageCacheKey(shipment, cloud.scope, cloud.url)
      : (shipment: Shipment) => productImageCacheKey(shipment.identity);
  const cacheKey = useCainiao || pdd || cloud ? keyFor(props.shipment) : props.cacheKey;
  const lifecycle = shipmentLifecycleKey(props.shipment);
  const isRetained = () => {
    if (!cacheKey || useCainiao && !cainiaoCurrent() || cloud && !cloudCurrent()) return false;
    return storedImageOwner(lifecycle, cacheKey, keyFor) != null;
  };
  const syncFirstPaintImage = () => deferDisk
    ? (cacheKey ? cachedProductImage(cacheKey) : null)
    : initialProductImage(cacheKey, isRetained);
  const [loaded, setLoaded] = useState<{
    key: string;
    lifecycle: string;
    isRetained: () => boolean;
    image: Awaited<ReturnType<typeof loadProductImage>>;
  } | null>(() => ({ key: cacheKey, lifecycle, isRetained, image: syncFirstPaintImage() }));

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
    if (props.allowDownload === false) {
      if (deferDisk || !cacheKey || typeof warmCachedProductImage !== "function") return;
      const controller = new AbortController();
      void warmCachedProductImage(cacheKey, controller.signal, isRetained).then((image) => {
        if (!controller.signal.aborted && image) setLoaded({ key: cacheKey, lifecycle, isRetained, image });
      }).catch(() => {});
      return () => controller.abort();
    }
    if (!imageURL && !cacheKey) return;
    const controller = new AbortController();
    void loadProductImage(imageURL, controller.signal, cacheKey ? { key: cacheKey, isRetained } : undefined).then((image) => {
      if (!controller.signal.aborted && image) setLoaded({ key: cacheKey, lifecycle, isRetained, image });
    }).catch(() => { /* Keep an already successful image during an optional refresh failure. */ });
    return () => controller.abort();
  }, [cacheKey, deferDisk, imageURL, lifecycle, props.allowDownload]);

  let image: Awaited<ReturnType<typeof loadProductImage>> = null;
  try {
    image = loaded?.key === cacheKey && loaded.lifecycle === lifecycle && (deferDisk || loaded.isRetained())
      ? loaded.image : syncFirstPaintImage();
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
