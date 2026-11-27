import {
  HStack,
  Image,
  LiveActivity,
  LiveActivityUI,
  LiveActivityUIExpandedCenter,
  Script,
  Text,
  ZStack,
} from "scripting";
import { CompleteParcelActivityIntent } from "./app_intents";
import { PIPI_CARD, ParcelLiveActivityCard, parcelActivityImage } from "./components/ParcelLiveActivityCard";
import { PARCEL_ACTIVITY_NAME, type ParcelActivityState } from "./services/parcel-activity-action";
import { parcelActivityCompactText } from "./services/parcel-pickup";
import { PARCEL_ACTIVITY_ART, legibleCodeOnDark, parcelCardArtwork, pickupCardPalette } from "./services/parcel-card-appearance";

export { PARCEL_ACTIVITY_ART };

// The rounded island needs half a capsule of clearance at its lower corner and 6 pt top breathing room;
// compactLeading and minimal use concentric 4 pt insets so the 27 pt circular badge fits unclipped.
const expandedActionInset = Math.ceil(PIPI_CARD.capsuleHeight / 2);
const expandedIslandAppearance = {
  dynamicIslandContentMargins: {
    compactLeading: { top: 4, bottom: 4, leading: 4 },
    minimal: { all: 4 },
    expanded: {
      top: 6,
      leading: PIPI_CARD.edge,
      trailing: expandedActionInset,
      bottom: expandedActionInset,
    },
  },
};

const PARCEL_ACTIVITY_BUILDER_KEY = "__pipiDeliveriesParcelPickupBuilder__";

type ParcelActivityBuilder = ReturnType<typeof LiveActivity.register<ParcelActivityState>>;

function registerParcelActivityOnce(): ParcelActivityBuilder {
  const host = globalThis as Record<string, unknown>;
  const existing = host[PARCEL_ACTIVITY_BUILDER_KEY] as ParcelActivityBuilder | undefined;
  if (typeof existing === "function") return existing;
  const builder = LiveActivity.register<ParcelActivityState>(
    PARCEL_ACTIVITY_NAME,
    (data) => {
      const imageRoot = `${FileManager.appGroupDocumentsDirectory}/${PARCEL_ACTIVITY_ART}`;
      const url = data.linkId ? Script.createRunSingleURLScheme(Script.name, {
        parcelActivity: data.linkId,
      }) : undefined;
      const compactCode = parcelActivityCompactText(data);
      const handoff = data.kind === "handoff";
      const meal = data.kind === "meal";
      const { mark, sticker } = parcelCardArtwork(data);
      const logoPath = sticker ? `${imageRoot}/${sticker.name}` : undefined;
      const brand = mark ? parcelActivityImage(`${imageRoot}/${mark.name}`) : null;
      const palette = pickupCardPalette(data);
      // Lock Screen activities align with the standard 14 pt notification margin.
      const width = Device.isiPhone ? Math.min(Device.screen.width, Device.screen.height) - 2 * 14 : undefined;
      const badgeSize = 27;
      const glyph = (
        <ZStack frame={{ width: badgeSize, height: badgeSize }} clipShape="circle"
          background={brand ? undefined : "rgba(255,255,255,0.16)"}>
          {brand ? <Image image={brand} renderingMode="original" resizable scaleToFill /> : (
            <Image systemName={meal ? "fork.knife" : handoff ? "tray.and.arrow.up.fill" : "shippingbox.fill"} font={15} foregroundStyle="white" />
          )}
        </ZStack>
      );
      const completion = data.linkId
        ? CompleteParcelActivityIntent({ linkId: data.linkId, kind: data.kind ?? "pickup" })
        : data.previewLinkId
          ? CompleteParcelActivityIntent({ linkId: data.previewLinkId, kind: "preview" })
          : undefined;
      const cardProps = {
        data, imageRoot, logoPath, url, preview: !data.linkId,
        completion,
      };
      const compactCodeColor = legibleCodeOnDark(palette.code, 0x000000);
      return (
        <LiveActivityUI
          {...expandedIslandAppearance}
          content={<ParcelLiveActivityCard {...cardProps} width={width} lockScreen lockScreenStyle={data.lockScreenStyle} />}
          compactLeading={<HStack widgetURL={url}>{glyph}</HStack>}
          compactTrailing={(
            <Text font={15} fontWeight="semibold" foregroundStyle={compactCodeColor}
              lineLimit={1} minScaleFactor={0.75} widgetURL={url}>
              {compactCode}
            </Text>
          )}
          minimal={<HStack widgetURL={url}>{glyph}</HStack>}
        >
          <LiveActivityUIExpandedCenter>
            <ParcelLiveActivityCard {...cardProps} width={width} expanded />
          </LiveActivityUIExpandedCenter>
        </LiveActivityUI>
      );
    },
  );
  host[PARCEL_ACTIVITY_BUILDER_KEY] = builder;
  return builder;
}

export const PipiParcelActivity = registerParcelActivityOnce();
