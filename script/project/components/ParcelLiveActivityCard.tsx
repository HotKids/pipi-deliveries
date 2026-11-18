import { Button, Circle, HStack, Image, Spacer, Text, VStack, ZStack, gradient, type AppIntent, type VirtualNode } from "scripting";
import type { ParcelActivityCompletion } from "../services/parcel-activity-action";
import { parcelCardArtwork, parcelCardPalette } from "../services/parcel-card-appearance";
import { parcelPickupShortCode, parcelPickupSubtitle, type ParcelActivityContent } from "../services/parcel-pickup";

// Pipi Home's shared and express-specific card specifications.
export const PIPI_CARD = {
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
  titleFont: 15,
  locationHeight: 17,
  locationFont: 11,
  locationIcon: 13,
  dividerHeight: 3,
  dotDiameter: 2.7,
  dotGap: 3.8,
  capsuleHeight: 35,
  capsuleFont: 12,
  capsuleInset: 11,
  capsuleIcon: 19,
  iconGap: 4,
  codeGap: 8,
  codeFont: 28,
  codeHeight: 32,
} as const;

const MAX_ACTIVITY_HEIGHT = 160;
// The expanded bottom region shares the height budget with the camera and system margins.
const EXPANDED_CONTENT_HEIGHT = Math.floor(MAX_ACTIVITY_HEIGHT - 36.67 - 2 * 8);

export function parcelActivityImage(path?: string): UIImage | null {
  if (!path) return null;
  try { return UIImage.fromFile(path); } catch { return null; }
}

export type ParcelLiveActivityCardProps = {
  data: ParcelActivityContent;
  imageRoot: string;
  logoPath?: string;
  width?: number;
  url?: string;
  completion?: AppIntent<ParcelActivityCompletion>;
  preview?: boolean;
  expanded?: boolean;
  lockScreen?: boolean;
  artwork?: VirtualNode;
  actionLabel?: string;
  actionPending?: boolean;
  locationText?: string;
  showingAddress?: boolean;
  onComplete?: () => void;
  onCopy?: () => void;
  onDetail?: () => void;
  onEditNote?: () => void;
  onLocationTap?: () => void;
};

export function ParcelLiveActivityCard({ data, imageRoot, logoPath, width, url, completion, preview, expanded, lockScreen, artwork,
  actionLabel, actionPending, locationText, showingAddress, onComplete, onCopy, onDetail, onEditNote, onLocationTap }: ParcelLiveActivityCardProps) {
  const card = PIPI_CARD;
  const scale = expanded ? EXPANDED_CONTENT_HEIGHT / card.height : width
    ? Math.min(width / card.width, lockScreen ? MAX_ACTIVITY_HEIGHT / card.height : 500 / card.width)
    : 1;
  const height = card.height * scale;
  const artWidth = card.artWidth * scale;
  const artHeight = card.artHeight * scale;
  const palette = parcelCardPalette(parcelCardArtwork(data).accent);
  const handoff = data.kind === "handoff";
  const logoSize = (handoff ? 20 : 26) * scale;
  const box = artwork ? null : parcelActivityImage(`${imageRoot}/box.png`);
  const logo = artwork ? null : parcelActivityImage(logoPath);
  const showCapsule = Boolean(data.code && (completion || preview || onComplete));
  const completionLabel = actionLabel || (handoff ? "我已寄件" : "我已取件");
  const dotRadius = card.dotDiameter / 2;
  const dividerTop = card.height - card.capsuleHeight - 2 * card.edge - card.dividerHeight / 2 - dotRadius;
  const dotsTop = dividerTop + card.dividerHeight / 2 - dotRadius;
  const gap = Math.min(Math.ceil(card.edge * 2 / 3),
    Math.max(0, (dotsTop - card.edge - card.titleHeight - card.locationHeight) / 2));
  const locationTop = dotsTop - gap - card.locationHeight;
  const titleTop = locationTop - gap - card.titleHeight;
  const subtitle = parcelPickupSubtitle(data, locationText, showingAddress);
  const dotCount = Math.floor((card.width - card.textLeft - card.edge + card.dotGap) /
    (card.dotDiameter + card.dotGap));
  const capsule = (
    <HStack spacing={card.iconGap * scale} padding={{ horizontal: card.capsuleInset * scale }}
      frame={{ height: card.capsuleHeight * scale }} fixedSize={{ horizontal: true, vertical: false }}
      background={{ style: palette.capsule, shape: "capsule" }} contentShape="capsule">
      <Image systemName="shippingbox.fill" font={card.capsuleIcon * scale}
        foregroundStyle="white" frame={{ width: card.capsuleIcon * scale, height: card.capsuleIcon * scale }} />
      <Text font={card.capsuleFont * scale} fontWeight="semibold" foregroundStyle="white" lineLimit={1}>{completionLabel}</Text>
    </HStack>
  );
  const titleRow = (
    <Text font={card.titleFont * scale} fontWeight="bold" foregroundStyle="rgba(255,255,255,0.9)" lineLimit={1}
      frame={{ height: card.titleHeight * scale, alignment: "leading" }}>{data.title}</Text>
  );
  const subtitleRow = (
    <HStack spacing={card.iconGap * scale} frame={{ height: card.locationHeight * scale, alignment: "leading" }}>
      {subtitle.text ? <>
        <Image systemName={subtitle.symbol} resizable scaleToFit foregroundStyle="rgba(255,255,255,0.85)"
          frame={{ width: card.locationIcon * scale, height: card.locationIcon * scale }} />
        <Text font={card.locationFont * scale} fontWeight="regular"
          foregroundStyle="rgba(255,255,255,0.85)" lineLimit={1}>{subtitle.text}</Text>
      </> : null}
    </HStack>
  );
  const code = (
    <Text font={card.codeFont * scale} fontWeight="semibold" foregroundStyle={palette.code}
      kerning={0.4 * scale} monospacedDigit lineLimit={1} minScaleFactor={12 / card.codeFont}
      frame={{ minWidth: 0, maxWidth: "infinity", minHeight: card.codeHeight * scale, alignment: "leading" }}>
      {parcelPickupShortCode(data.code)}
    </Text>
  );

  // Scripting snapshots Live Activities before the host proposes a layout size.
  return (
    <HStack alignment="center" spacing={(card.textLeft - card.artWidth) * scale}
      frame={{ minHeight: height, maxHeight: height, maxWidth: "infinity" }}
      background={expanded ? undefined : gradient("linear", {
        colors: [...palette.gradient], startPoint: "leading", endPoint: "trailing",
      })}
      activityBackgroundTint={lockScreen ? "clear" : undefined}
      clipShape={expanded || lockScreen ? undefined : { type: "rect", cornerRadius: card.corner * scale }}
      widgetURL={url} onTapGesture={onDetail} contentShape="rect">
      <ZStack frame={{ width: artWidth, height: artHeight }}
        offset={{ x: 0, y: card.artTop * scale - (height - artHeight) / 2 }}>
        {artwork ? <ZStack scaleEffect={scale}>{artwork}</ZStack> : box ? (
          <Image image={box} resizable scaleToFit frame={{ width: artWidth, height: artHeight }} />
        ) : (
          <Image systemName="shippingbox.fill" font={42 * scale} foregroundStyle="white" />
        )}
        {logo ? (
          <Image image={logo} resizable scaleToFit frame={{ width: logoSize, height: logoSize }}
            position={{ x: card.logoX * scale, y: (card.logoY - card.artTop) * scale }} />
        ) : null}
      </ZStack>
      <VStack alignment="leading" spacing={0} padding={{ top: titleTop * scale, bottom: card.edge * scale, trailing: card.edge * scale }}
        frame={{ minWidth: 0, maxWidth: "infinity", minHeight: height, maxHeight: height, alignment: "leading" }}>
        {onEditNote ? <Button buttonStyle="plain" action={onEditNote}>{titleRow}</Button> : titleRow}
        <VStack alignment="leading" spacing={0} padding={{ top: gap * scale }}>
          {onLocationTap ? <Button buttonStyle="plain" action={onLocationTap}>{subtitleRow}</Button> : subtitleRow}
        </VStack>
        <HStack spacing={0} frame={{ maxWidth: "infinity", minHeight: card.dividerHeight * scale, maxHeight: card.dividerHeight * scale }}
          padding={{ top: (dividerTop - locationTop - card.locationHeight) * scale }}>
          {Array.from({ length: dotCount }, (_, index) => (
            <HStack key={index} spacing={0} frame={index > 0 ? { maxWidth: "infinity", alignment: "trailing" } : undefined}>
              <Circle fill="rgba(255,255,255,0.18)" frame={{ width: card.dotDiameter * scale, height: card.dotDiameter * scale }} />
            </HStack>
          ))}
        </HStack>
        <Spacer minLength={0} />
        <HStack spacing={card.codeGap * scale}
          frame={{ maxWidth: "infinity", minHeight: card.capsuleHeight * scale, maxHeight: card.capsuleHeight * scale }}>
          {onCopy ? <Button buttonStyle="plain" action={onCopy}>{code}</Button> : code}
          {showCapsule ? (
            completion ? <Button intent={completion} buttonStyle="plain">{capsule}</Button> :
              onComplete ? <Button action={onComplete} buttonStyle="plain" disabled={actionPending}>{capsule}</Button> : capsule
          ) : null}
        </HStack>
      </VStack>
    </HStack>
  );
}
