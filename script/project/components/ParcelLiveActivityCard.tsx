import { Button, Circle, HStack, Image, Rectangle, Spacer, Text, VStack, ZStack, gradient, type AppIntent, type VirtualNode } from "scripting";
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
  lockScreenPreview?: boolean;
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

export function ParcelLiveActivityCard({ data, imageRoot, logoPath, width, url, completion, preview, expanded, lockScreen, lockScreenPreview, artwork,
  actionLabel, actionPending, locationText, showingAddress, onComplete, onCopy, onDetail, onEditNote, onLocationTap }: ParcelLiveActivityCardProps) {
  const card = PIPI_CARD;
  const capsuleTop = card.height - card.edge - card.capsuleHeight;
  const dotRadius = card.dotDiameter / 2;
  const dividerTop = capsuleTop - card.edge - card.dividerHeight / 2 - dotRadius;
  const dotsTop = dividerTop + card.dividerHeight / 2 - dotRadius;
  const gap = Math.min(Math.ceil(card.edge * 2 / 3),
    Math.max(0, (dotsTop - card.edge - card.titleHeight - card.locationHeight) / 2));
  const locationTop = dotsTop - gap - card.locationHeight;
  const titleTop = locationTop - gap - card.titleHeight;
  // The island supplies the outer margins around the full-size Pipi rows.
  const top = expanded ? titleTop : 0;
  const bottom = expanded ? capsuleTop + card.capsuleHeight : card.height;
  const widthScale = (width ?? card.width) / card.width;
  const scale = lockScreen || lockScreenPreview || expanded
    ? Math.min(widthScale, MAX_ACTIVITY_HEIGHT / card.height) : widthScale;
  const height = (bottom - top) * scale;
  const artWidth = card.artWidth * scale;
  const artHeight = card.artHeight * scale;
  const fitsHost = (lockScreen || expanded) && width !== undefined;
  const flexibleHeight = lockScreen && width !== undefined;
  const slot = (size: number, minimum = 0) => ({
    minHeight: (flexibleHeight ? minimum : size) * scale,
    idealHeight: size * scale,
    maxHeight: size * scale,
  });
  const hostInset = fitsHost ? card.iconGap : 0;
  const hostVerticalInset = flexibleHeight ? card.textLeft - card.artWidth : 0;
  const contentWidth = (card.width - card.textLeft) * scale;
  const { accent } = parcelCardArtwork(data);
  const palette = parcelCardPalette(accent);
  const cardShape = { type: "rect", cornerRadius: card.corner * scale } as const;
  const cardBackground = gradient("linear", {
    colors: [...palette.gradient], startPoint: "leading", endPoint: "trailing",
  });
  const titleColor = "rgba(255,255,255,0.9)";
  const locationColor = "rgba(255,255,255,0.85)";
  const dotColor = "rgba(255,255,255,0.18)";
  const handoff = data.kind === "handoff";
  const logoSize = (handoff ? 20 : 26) * scale;
  const box = artwork ? null : parcelActivityImage(`${imageRoot}/box.png`);
  const logo = artwork ? null : parcelActivityImage(logoPath);
  const showCapsule = Boolean(data.code && (completion || preview || onComplete));
  const completionLabel = actionLabel || (handoff ? "我已寄件" : "我已取件");
  const capsuleWidth = card.capsuleInset * 2 + card.capsuleIcon + card.iconGap + completionLabel.length * card.capsuleFont;
  const codeWidth = showCapsule
    ? Math.max(0, contentWidth - (card.edge + card.codeGap + capsuleWidth) * scale)
    : "infinity";
  const subtitle = parcelPickupSubtitle(data, locationText, showingAddress);
  const dotCount = Math.floor((card.width - card.textLeft - card.edge + card.dotGap) /
    (card.dotDiameter + card.dotGap));
  const actionPriority = fitsHost ? 0 : 1;
  const space = (size: number) => <Spacer minLength={0} frame={slot(size)} layoutPriority={-1} />;
  const capsulePadding = fitsHost ? (
    <Spacer minLength={hostInset * scale} layoutPriority={-1}
      frame={{ minWidth: hostInset * scale, idealWidth: card.capsuleInset * scale, maxWidth: card.capsuleInset * scale }} />
  ) : null;
  const capsule = (
    <HStack spacing={fitsHost ? 0 : card.iconGap * scale} padding={{ horizontal: fitsHost ? 0 : card.capsuleInset * scale }}
      frame={slot(card.capsuleHeight)} fixedSize={{ horizontal: !fitsHost, vertical: false }} layoutPriority={actionPriority}
      background={{ style: palette.capsule, shape: "capsule" }} contentShape="capsule">
      {capsulePadding}
      <Image systemName="shippingbox.fill" font={card.capsuleIcon * scale}
        foregroundStyle="white" frame={{ width: card.capsuleIcon * scale, height: card.capsuleIcon * scale }} />
      {fitsHost ? <Spacer minLength={0} frame={{ width: card.iconGap * scale }} /> : null}
      <Text font={card.capsuleFont * scale} fontWeight="semibold" foregroundStyle="white" lineLimit={1}
        minScaleFactor={fitsHost ? 0.8 : undefined}>{completionLabel}</Text>
      {capsulePadding}
    </HStack>
  );
  const titleRow = (
    <Text font={card.titleFont * scale} fontWeight="bold" foregroundStyle={titleColor} lineLimit={1}
      minScaleFactor={fitsHost ? 0.7 : undefined}
      frame={{ ...slot(card.titleHeight, card.titleFont * 0.7), alignment: "leading" }}
      clipped={fitsHost}>{data.title}</Text>
  );
  const subtitleRow = (
    <HStack spacing={card.iconGap * scale} frame={{ ...slot(card.locationHeight, card.locationIcon), alignment: "leading" }}>
      {subtitle.text ? <>
        <Image systemName={subtitle.symbol} resizable scaleToFit foregroundStyle={locationColor}
          frame={{ width: card.locationIcon * scale, height: card.locationIcon * scale }} />
        <Text font={card.locationFont * scale} fontWeight="regular"
          minScaleFactor={fitsHost ? 0.75 : undefined}
          foregroundStyle={locationColor} lineLimit={1}>{subtitle.text}</Text>
      </> : null}
    </HStack>
  );
  const code = (
    <Text font={card.codeFont * scale} fontWeight="semibold" fontWidth="condensed"
      foregroundStyle={palette.code}
      kerning={0.4 * scale} lineLimit={1} allowsTightening={fitsHost} minScaleFactor={(fitsHost ? 9 : 12) / card.codeFont}
      frame={{ ...slot(card.codeHeight), minWidth: fitsHost ? undefined : 0, maxWidth: codeWidth, alignment: "leading" }}
      layoutPriority={1}>
      {parcelPickupShortCode(data.code)}
    </Text>
  );
  const boxArtwork = (
    <ZStack frame={{ width: artWidth, height: artHeight }}
      offset={{ x: 0, y: (card.artTop - top) * scale - (height - artHeight) / 2 }}>
      {artwork ? <ZStack scaleEffect={scale}>{artwork}</ZStack> : box ? (
        <Image image={box} resizable scaleToFit frame={{ width: artWidth, height: artHeight }} />
      ) : (
        <Image systemName="shippingbox.fill" font={42 * scale} foregroundStyle={titleColor} />
      )}
      {logo ? (
        <Image image={logo} resizable scaleToFit frame={{ width: logoSize, height: logoSize }}
          position={{ x: card.logoX * scale, y: (card.logoY - card.artTop) * scale }} />
      ) : null}
    </ZStack>
  );

  // Scripting snapshots Live Activities before the host proposes a layout size.
  return (
    <HStack alignment="top" spacing={(card.textLeft - card.artWidth) * scale}
      frame={{ ...slot(bottom - top), minWidth: 0, maxWidth: "infinity", alignment: "topLeading" }}
      background={expanded ? undefined : cardBackground}
      activityBackgroundTint={lockScreen ? "clear" : undefined}
      clipShape={expanded || lockScreen ? undefined : cardShape}
      widgetURL={url} onTapGesture={onDetail} contentShape="rect">
      {fitsHost ? (
        // The artwork's fixed canvas must not impose a minimum on a narrow host.
        <Rectangle fill="clear" frame={{ ...slot(bottom - top), minWidth: 0, idealWidth: artWidth, maxWidth: artWidth }}
          background={{ alignment: "leading", content: boxArtwork }} clipped layoutPriority={-1} />
      ) : (
        <ZStack frame={{ width: artWidth, ...slot(bottom - top) }}>{boxArtwork}</ZStack>
      )}
      <VStack alignment="leading" spacing={0} padding={{ vertical: hostVerticalInset * scale, trailing: card.edge * scale }}
        frame={{ ...slot(bottom - top), minWidth: 0, maxWidth: fitsHost ? contentWidth : "infinity", alignment: "topLeading" }}
        layoutPriority={fitsHost ? 1 : 0}>
        {space(titleTop - top - hostVerticalInset)}
        {onEditNote ? <Button buttonStyle="plain" action={onEditNote}>{titleRow}</Button> : titleRow}
        {space(gap)}
        {onLocationTap ? <Button buttonStyle="plain" action={onLocationTap}>{subtitleRow}</Button> : subtitleRow}
        {space(dividerTop - locationTop - card.locationHeight)}
        <HStack spacing={0} frame={{ ...slot(card.dividerHeight), maxWidth: "infinity" }}
          layoutPriority={fitsHost ? -1 : 0} clipped={fitsHost}>
          {Array.from({ length: dotCount }, (_, index) => (
            <HStack key={index} spacing={0} frame={index > 0 ? { maxWidth: "infinity", alignment: "trailing" } : undefined}>
              <Circle fill={dotColor} frame={{ width: card.dotDiameter * scale, height: card.dotDiameter * scale }} />
            </HStack>
          ))}
        </HStack>
        {space(capsuleTop - dividerTop - card.dividerHeight)}
        <HStack spacing={fitsHost ? 0 : card.codeGap * scale}
          frame={{ ...slot(card.capsuleHeight, card.capsuleIcon), maxWidth: "infinity" }} layoutPriority={fitsHost ? 1 : 0}>
          {onCopy ? <Button buttonStyle="plain" action={onCopy}>{code}</Button> : code}
          {fitsHost ? <Spacer minLength={showCapsule ? card.codeGap * scale : 0} /> : null}
          {showCapsule ? (
            completion ? <Button intent={completion} buttonStyle="plain" layoutPriority={actionPriority}>{capsule}</Button> :
              onComplete ? <Button action={onComplete} buttonStyle="plain" disabled={actionPending} layoutPriority={actionPriority}>{capsule}</Button> : capsule
          ) : null}
        </HStack>
        {fitsHost ? space(bottom - capsuleTop - card.capsuleHeight - hostVerticalInset) : null}
      </VStack>
    </HStack>
  );
}
