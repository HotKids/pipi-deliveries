import {
  HStack,
  Image,
  LiveActivity,
  LiveActivityUI,
  LiveActivityUIExpandedBottom,
  Script,
  Text,
} from "scripting";
import { CompleteParcelActivityIntent } from "./app_intents";
import { ParcelLiveActivityCard } from "./components/ParcelLiveActivityCard";
import { PARCEL_ACTIVITY_NAME, type ParcelActivityState } from "./services/parcel-activity-action";

export const PARCEL_ACTIVITY_ART = "pipi-deliveries/parcel-activity-art-v1";

export const PipiParcelActivity = LiveActivity.register<ParcelActivityState>(
  PARCEL_ACTIVITY_NAME,
  (data) => {
    const imageRoot = `${FileManager.appGroupDocumentsDirectory}/${PARCEL_ACTIVITY_ART}`;
    const url = data.linkId ? Script.createRunSingleURLScheme(Script.name, {
      parcelActivity: data.linkId,
    }) : undefined;
    const compactCode = data.code.length <= 8 ? data.code : data.code.replace(/[^A-Za-z0-9]/g, "");
    const handoff = data.kind === "handoff";
    const logoPath = data.platform ? `${imageRoot}/${handoff ? "handoff-" : ""}${data.platform}.png` : undefined;
    const glyph = logoPath
      ? <Image filePath={logoPath} renderingMode="original" resizable scaleToFit frame={{ width: 20, height: 20 }} />
      : <Image systemName={handoff ? "tray.and.arrow.up.fill" : "shippingbox.fill"} foregroundStyle="white" />;
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
            {compactCode && compactCode.length <= 8 ? compactCode : handoff ? "待寄件" : "待取件"}
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
