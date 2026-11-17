import { Button, Canvas, GeometryReader, HStack, Image, Text, ZStack, gradient, type AppIntent } from "scripting";
import type { ParcelActivityCompletion } from "../services/parcel-activity-action";
import type { ParcelActivityContent } from "../services/parcel-pickup";

// Pipi Home's express card uses pickup_card_spec.json and express_pickup_card.dart.
const PIPI_CARD = {
  width: 328,
  height: 132,
  corner: 24,
  artWidth: 100,
  artHeight: 117,
  artTop: 9,
  logoX: 50,
  logoY: 73,
  textLeft: 102,
  edge: 12,
  titleHeight: 21,
  locationHeight: 17,
  dividerHeight: 3,
  dotRadius: 1.35,
  dotGap: 3.8,
  codeHeight: 32,
  capsuleHeight: 35,
  capsuleInset: 11,
  capsuleIcon: 19,
  iconGap: 4,
  codeGap: 8,
} as const;

export function ParcelLiveActivityCard({ data, imageRoot, logoPath, url, completion, preview, expanded }: {
  data: ParcelActivityContent;
  imageRoot: string;
  logoPath?: string;
  url?: string;
  completion?: AppIntent<ParcelActivityCompletion>;
  preview?: boolean;
  expanded?: boolean;
}) {
  const card = PIPI_CARD;
  const handoff = data.kind === "handoff";
  const logoSize = handoff ? 20 : 26;
  const showCapsule = Boolean(data.code && (completion || preview));
  const completionLabel = handoff ? "我已寄件" : "我已取件";
  const capsuleFont = 12;
  const capsuleWidth = 2 * card.capsuleInset + card.capsuleIcon + card.iconGap + 4 * capsuleFont;
  const textWidth = card.width - card.textLeft - card.edge;
  const dividerTop = card.height - card.capsuleHeight - 2 * card.edge - card.dividerHeight / 2 - card.dotRadius;
  const dotsTop = dividerTop + card.dividerHeight / 2 - card.dotRadius;
  const bodyGap = Math.min(Math.ceil(card.edge * 2 / 3),
    Math.max(0, (dotsTop - card.edge - card.titleHeight - card.locationHeight) / 2));
  const locationTop = dotsTop - bodyGap - card.locationHeight;
  const titleTop = locationTop - bodyGap - card.titleHeight;
  const capsuleTop = card.height - card.edge - card.capsuleHeight;
  const codeTop = capsuleTop + (card.capsuleHeight - card.codeHeight) / 2;
  const codeWidth = textWidth - (showCapsule ? capsuleWidth + card.codeGap : 0);

  return (
    <GeometryReader
      frame={preview ? { maxWidth: card.width, minHeight: card.height, maxHeight: card.height } : undefined}
      aspectRatio={preview ? undefined : { value: card.width / card.height, contentMode: "fit" }}
    >
      {({ size }) => {
        const scale = Math.max(size.width, 1) / card.width;
        const at = (x: number, y: number, width: number, height: number, centered = false) => ({
          frame: { width: width * scale, height: height * scale, alignment: centered ? "center" as const : "leading" as const },
          position: { x: (x + width / 2) * scale, y: (y + height / 2) * scale },
        });
        const capsule = (
          <HStack spacing={card.iconGap * scale}
            frame={{ width: capsuleWidth * scale, height: card.capsuleHeight * scale }}
            background={{ style: "rgba(255,255,255,0.16)", shape: "capsule" }}
            contentShape="capsule">
            <Image systemName="shippingbox.fill" font={card.capsuleIcon * scale} foregroundStyle="white" />
            <Text font={capsuleFont * scale} fontWeight="semibold" foregroundStyle="white" lineLimit={1}>{completionLabel}</Text>
          </HStack>
        );
        return (
          <ZStack alignment="topLeading"
            frame={{ width: card.width * scale, height: card.height * scale }}
            background={expanded ? undefined : gradient("linear", {
              colors: ["#22262D", "#38232D"], startPoint: "leading", endPoint: "trailing",
            })}
            activityBackgroundTint={expanded ? undefined : "clear"}
            clipShape={expanded ? undefined : { type: "rect", cornerRadius: card.corner * scale }}
            widgetURL={url}>
            <Image filePath={`${imageRoot}/box.png`} resizable scaleToFit
              {...at(0, card.artTop, card.artWidth, card.artHeight, true)} />
            {logoPath ? <Image filePath={logoPath} resizable scaleToFit
              {...at(card.logoX - logoSize / 2, card.logoY - logoSize / 2, logoSize, logoSize, true)} /> : null}
            <Text font={15 * scale} fontWeight="bold" foregroundStyle="rgba(255,255,255,0.9)" lineLimit={1}
              {...at(card.textLeft, titleTop, textWidth, card.titleHeight)}>{data.title}</Text>
            {data.location ? (
              <HStack spacing={card.iconGap * scale} {...at(card.textLeft, locationTop, textWidth, card.locationHeight)}>
                <Image systemName={handoff ? "clock" : "storefront"} font={13 * scale}
                  foregroundStyle="rgba(255,255,255,0.85)" />
                <Text font={11 * scale} foregroundStyle="rgba(255,255,255,0.85)" lineLimit={1}>{data.location}</Text>
              </HStack>
            ) : null}
            <Canvas opaque={false} {...at(card.textLeft, dividerTop, textWidth, card.dividerHeight)}
              draw={(ctx, bounds) => {
                const radius = card.dotRadius * scale;
                const span = bounds.width - 2 * radius;
                const intervals = Math.floor(span / ((2 * card.dotRadius + card.dotGap) * scale));
                ctx.fillStyle = "rgba(255,255,255,0.18)";
                for (let index = 0; index <= intervals; index++) {
                  const x = radius + (intervals ? span * index / intervals : 0);
                  ctx.beginPath();
                  ctx.arc(x, bounds.height / 2, radius, 0, Math.PI * 2);
                  ctx.fill();
                }
              }} />
            <Text font={28 * scale} fontWeight="semibold" foregroundStyle="white" monospacedDigit
              lineLimit={1} minScaleFactor={12 / 28} {...at(card.textLeft, codeTop, codeWidth, card.codeHeight)}>{data.code}</Text>
            {showCapsule ? (
              <ZStack {...at(card.width - card.edge - capsuleWidth, capsuleTop, capsuleWidth, card.capsuleHeight, true)}>
                {completion ? <Button intent={completion} buttonStyle="plain">{capsule}</Button> : capsule}
              </ZStack>
            ) : null}
          </ZStack>
        );
      }}
    </GeometryReader>
  );
}
