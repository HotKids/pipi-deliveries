import {
  HStack,
  Image,
  LiveActivity,
  LiveActivityUI,
  LiveActivityUIExpandedBottom,
  Script,
  Text,
  ZStack,
} from "scripting";
import { CompleteParcelActivityIntent } from "./app_intents";
import { ParcelLiveActivityCard, parcelActivityImage } from "./components/ParcelLiveActivityCard";
import { iconTileShape } from "./components/icon-tile";
import { PARCEL_ACTIVITY_NAME, type ParcelActivityState } from "./services/parcel-activity-action";
import { parcelPickupShortCode } from "./services/parcel-pickup";

export const PARCEL_ACTIVITY_ART = "pipi-deliveries/parcel-activity-art-v1";

export const PipiParcelActivity = LiveActivity.register<ParcelActivityState>(
  PARCEL_ACTIVITY_NAME,
  (data) => {
    const imageRoot = `${FileManager.appGroupDocumentsDirectory}/${PARCEL_ACTIVITY_ART}`;
    const url = data.linkId ? Script.createRunSingleURLScheme(Script.name, {
      parcelActivity: data.linkId,
    }) : undefined;
    const compactCode = parcelPickupShortCode(data.code);
    const handoff = data.kind === "handoff";
    const brandPath = data.platform ? `${imageRoot}/brand-${data.platform}.png` : undefined;
    const logoPath = handoff ? brandPath : data.platform ? `${imageRoot}/${data.platform}.png` : undefined;
    const brand = parcelActivityImage(brandPath);
    const badgeSize = 20;
    const glyph = (
      <ZStack frame={{ width: badgeSize, height: badgeSize }} clipShape={iconTileShape(badgeSize)}
        background={brand ? undefined : "rgba(255,255,255,0.16)"}>
        {brand ? <Image image={brand} renderingMode="original" resizable scaleToFill /> : (
          <Image systemName={handoff ? "tray.and.arrow.up.fill" : "shippingbox.fill"} font={12} foregroundStyle="white" />
        )}
      </ZStack>
    );
    const cardProps = {
      data, imageRoot, logoPath, url, preview: !data.linkId,
      completion: data.linkId
        ? CompleteParcelActivityIntent({ linkId: data.linkId, kind: handoff ? "handoff" : "pickup" })
        : undefined,
    };
    return (
      <LiveActivityUI
        content={<ParcelLiveActivityCard {...cardProps} />}
        compactLeading={<HStack widgetURL={url}>{glyph}</HStack>}
        compactTrailing={(
          <Text font={13} monospacedDigit lineLimit={1} minScaleFactor={0.7}>
            {compactCode && Array.from(compactCode).length <= 8 ? compactCode : handoff ? "待寄件" : "待取件"}
          </Text>
        )}
        minimal={<HStack widgetURL={url}>{glyph}</HStack>}
      >
        <LiveActivityUIExpandedBottom>
          <ParcelLiveActivityCard {...cardProps} expanded />
        </LiveActivityUIExpandedBottom>
      </LiveActivityUI>
    );
  },
);
