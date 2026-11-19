import { Button, Circle, HStack, Image, Rectangle, Script, Spacer, Text, VStack, ZStack, gradient, type AppIntent, type VirtualNode } from "scripting";
import type { ParcelActivityCompletion } from "../services/parcel-activity-action";
import { PARCEL_LOCK_SCREEN_BOX, parcelCardArtwork, pickupCardPalette } from "../services/parcel-card-appearance";
import { parcelPickupShortCode, parcelPickupSubtitle, type ParcelActivityContent } from "../services/parcel-pickup";
import { MEAL_ARTWORK_TOKENS } from "./pickup-card-tokens.generated";

// Shared geometry and typography for the Pipi pickup card.
export const PIPI_CARD = {
  width: 328,
  height: 132,
  corner: 24,
  artWidth: 100,
  artHeight: 117,
  artTop: 1.5,
  logoX: 50,
  logoY: 64,
  textLeft: 102,
  edge: 12,
  titleHeight: 21,
  titleFont: 16,
  titleLineHeight: 19,
  locationHeight: 17,
  locationFont: 12,
  locationLineHeight: 15,
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
  codeFont: 26.5,
  codeHeight: 32,
} as const;

const MAX_ACTIVITY_HEIGHT = 160;
const MIN_COMPACT_ART_WIDTH = PIPI_CARD.artWidth / 2;
const SMART_STACK_MAX_WIDTH = 198;
const SMART_STACK_ART_COLUMN_WIDTH = 56;
const SMART_STACK_ART_WIDTH = 64;
const SMART_STACK_ART_GAP = 4.6;
const SMART_STACK_ROW_GAP = 6;
const SMART_STACK_TRAILING_INSET = 10;
const SMART_STACK_CODE_FONT = 29;
// The larger SF digits leave more leading above their visible glyphs than the title leaves below.
const SMART_STACK_DIVIDER_INK_OFFSET = 2;

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
  onArtworkTap?: () => void;
};

export function ParcelLiveActivityCard({ data, imageRoot, logoPath, width, url, completion, preview, expanded, lockScreen, artwork,
  actionLabel, actionPending, locationText, showingAddress, onComplete, onCopy, onDetail, onEditNote,
  onLocationTap, onArtworkTap }: ParcelLiveActivityCardProps) {
  const isMeal = data.kind === "meal";
  const card = PIPI_CARD;
  const { logoX, logoY } = isMeal ? MEAL_ARTWORK_TOKENS : card;
  const capsuleTop = card.height - card.edge - card.capsuleHeight;
  const dotRadius = card.dotDiameter / 2;
  const dividerTop = capsuleTop - card.edge - card.dividerHeight / 2 - dotRadius;
  const dotsTop = dividerTop + card.dividerHeight / 2 - dotRadius;
  const gap = Math.min(Math.ceil(card.edge * 2 / 3),
    Math.max(0, (dotsTop - card.edge - card.titleHeight - card.locationHeight) / 2));
  const locationTop = dotsTop - gap - card.locationHeight;
  const titleTop = locationTop - gap - card.titleHeight;
  const locationToDivider = dividerTop - locationTop - card.locationHeight;
  const dividerToCapsule = capsuleTop - dividerTop - card.dividerHeight;
  // The island supplies the outer margins around the full-size Pipi rows.
  const top = expanded ? titleTop : 0;
  const bottom = expanded ? capsuleTop + card.capsuleHeight : card.height;
  const widthScale = (width ?? card.width) / card.width;
  const scale = lockScreen || expanded
    ? Math.min(widthScale, MAX_ACTIVITY_HEIGHT / card.height) : widthScale;
  // The island has less height under its camera area than the lock screen.
  const verticalScale = expanded ? Math.min(scale, 1) : scale;
  const artWidth = card.artWidth * scale;
  const artColumnWidth = expanded ? artWidth - card.edge * scale : artWidth;
  const artHeight = card.artHeight * scale;
  const flexibleHeight = lockScreen || expanded;
  const fitsHost = expanded || (lockScreen && width !== undefined);
  const centerLockScreenMeal = lockScreen && isMeal;
  const artworkAlignment = centerLockScreenMeal ? "leading" : "topLeading";
  const artTop = isMeal && !lockScreen && !expanded ? MEAL_ARTWORK_TOKENS.artTop : card.artTop;
  const artOffset = centerLockScreenMeal ? 0 : (artTop - top) * scale;
  const sharesSmartStack = lockScreen && fitsHost;
  const artworkFrame = lockScreen && fitsHost
    ? { maxWidth: artWidth, maxHeight: artHeight }
    : { width: artWidth, height: artHeight };
  const slot = (size: number, minimum = 0) => ({
    minHeight: (flexibleHeight ? minimum : size) * verticalScale,
    idealHeight: size * verticalScale,
    maxHeight: size * verticalScale,
  });
  const actionRowHeight = slot(card.capsuleHeight, expanded ? card.capsuleHeight : card.capsuleIcon + 2 * card.iconGap);
  const hostInset = fitsHost ? card.iconGap : 0;
  const hostVerticalInset = lockScreen ? card.textLeft - card.artWidth : 0;
  const contentWidth = (card.width - card.textLeft) * scale;
  const assets = parcelCardArtwork(data);
  const palette = pickupCardPalette(data);
  const mealPath = (file?: { path: string; name: string }) => file &&
    (lockScreen || expanded ? `${imageRoot}/${file.name}` : `${Script.directory}/assets/${file.path}`);
  const mealImagePath = isMeal ? mealPath(assets.meal) : undefined;
  const mealStickerPath = isMeal ? mealPath(assets.mealSticker) : undefined;
  const cardShape = { type: "rect", cornerRadius: card.corner * scale } as const;
  const cardBackground = gradient("linear", {
    colors: [...palette.gradient], startPoint: "leading", endPoint: "trailing",
  });
  const titleColor = "rgba(255,255,255,0.9)";
  const locationColor = "rgba(255,255,255,0.85)";
  const dotColor = "rgba(255,255,255,0.18)";
  const handoff = data.kind === "handoff";
  const stickerWidth = isMeal ? MEAL_ARTWORK_TOKENS.stickerSize * (data.mealStyle?.stickerScale ?? 1)
    : handoff ? 20 : 26;
  const logoSize = stickerWidth * scale;
  const boxPath = `${imageRoot}/box.png`;
  const watchBoxPath = `${imageRoot}/${PARCEL_LOCK_SCREEN_BOX}`;
  const hasWatchBox = !isMeal && !artwork && lockScreen && FileManager.isFileSync(watchBoxPath);
  const lockScreenBoxPath = !isMeal && !artwork && lockScreen && FileManager.isFileSync(boxPath)
    ? boxPath : hasWatchBox ? watchBoxPath : undefined;
  const box = isMeal || artwork || lockScreenBoxPath ? null : parcelActivityImage(boxPath);
  const artworkFile = !artwork && mealImagePath && FileManager.isFileSync(mealImagePath)
    ? mealImagePath : lockScreenBoxPath;
  const artworkImage = artworkFile ? { filePath: artworkFile } : box ? { image: box } : undefined;
  const logo = artwork ? null : parcelActivityImage(logoPath);
  const stickerImage = !artwork && mealStickerPath && FileManager.isFileSync(mealStickerPath)
    ? { filePath: mealStickerPath } : logo ? { image: logo } : undefined;
  const artworkSymbol = isMeal ? "fork.knife" : "shippingbox.fill";
  const showCapsule = Boolean(data.code && (completion || preview || onComplete));
  const completionLabel = actionLabel || (isMeal ? "我已取餐" : handoff ? "我已寄件" : "我已取件");
  const capsuleWidth = card.capsuleInset * 2 + card.capsuleIcon + card.iconGap + completionLabel.length * card.capsuleFont;
  const codeWidth = showCapsule
    ? Math.max(0, contentWidth - (card.edge + card.codeGap + capsuleWidth) * scale)
    : "infinity";
  const subtitle = parcelPickupSubtitle(data, locationText, showingAddress);
  const pickupCode = isMeal ? data.code : parcelPickupShortCode(data.code);
  const dividerDots = (width: number, scale: number) => {
    const count = Math.floor((width + card.dotGap) / (card.dotDiameter + card.dotGap));
    const diameter = card.dotDiameter * scale;
    return Array.from({ length: count }, (_, index) => (
      <HStack key={index} spacing={0} frame={index > 0 ? { maxWidth: "infinity", alignment: "trailing" } : undefined}>
        <Circle fill={dotColor} frame={{ width: diameter, height: diameter }} />
      </HStack>
    ));
  };
  const capsuleLabelScale = 0.8;
  const capsuleMinWidth = lockScreen
    ? (2 * hostInset + card.capsuleIcon + card.iconGap + completionLabel.length * card.capsuleFont * capsuleLabelScale) * scale
    : undefined;
  const space = (size: number, minimum = 0, priority = -1) =>
    <Spacer minLength={0} frame={slot(size, minimum)} layoutPriority={priority} />;
  const capsulePadding = lockScreen ? (
    <Spacer minLength={hostInset * scale} layoutPriority={-1}
      frame={{ minWidth: hostInset * scale, idealWidth: card.capsuleInset * scale, maxWidth: card.capsuleInset * scale }} />
  ) : null;
  const capsule = (
    <HStack spacing={lockScreen ? 0 : card.iconGap * scale} padding={{ horizontal: lockScreen ? 0 : card.capsuleInset * scale }}
      frame={{ ...actionRowHeight, minWidth: capsuleMinWidth }}
      fixedSize={{ horizontal: !lockScreen, vertical: false }} layoutPriority={1}
      background={{ style: palette.capsule, shape: "capsule" }} contentShape="capsule">
      {capsulePadding}
      <Image systemName={isMeal ? "fork.knife" : "shippingbox.fill"} font={card.capsuleIcon * scale}
        foregroundStyle={palette.capsuleForeground} frame={{ width: card.capsuleIcon * scale, height: card.capsuleIcon * scale }} />
      {lockScreen ? <Spacer minLength={0} frame={{ width: card.iconGap * scale }} /> : null}
      <Text font={card.capsuleFont * scale} fontWeight="semibold" foregroundStyle={palette.capsuleForeground} lineLimit={1}
        minScaleFactor={lockScreen ? capsuleLabelScale : undefined} layoutPriority={1}>{completionLabel}</Text>
      {capsulePadding}
    </HStack>
  );
  const titleRow = (
    <Text font={card.titleFont * scale} fontWeight="semibold" foregroundStyle={titleColor} lineLimit={1}
      minScaleFactor={fitsHost ? 0.7 : undefined}
      frame={expanded ? undefined : { ...slot(card.titleHeight, card.titleFont * 0.7), alignment: "leading" }}
      layoutPriority={lockScreen ? 1 : undefined} clipped={!expanded && fitsHost}>{data.title}</Text>
  );
  const subtitleRow = (
    <HStack spacing={card.iconGap * scale}
      frame={expanded ? undefined : { ...slot(card.locationHeight, card.locationIcon), alignment: "leading" }}>
      {subtitle.text ? <>
        <Image systemName={subtitle.symbol} resizable scaleToFit foregroundStyle={locationColor}
          frame={{ width: card.locationIcon * scale, height: card.locationIcon * scale }} />
        <Text font={card.locationFont * scale} fontWeight="medium"
          minScaleFactor={fitsHost ? 0.75 : undefined}
          foregroundStyle={locationColor} lineLimit={1}>{subtitle.text}</Text>
      </> : null}
    </HStack>
  );
  const code = (
    <Text font={card.codeFont * scale} fontWeight="semibold" fontWidth="standard"
      foregroundStyle={palette.code}
      kerning={0} lineLimit={1} allowsTightening={fitsHost}
      minScaleFactor={lockScreen ? 11 / (card.codeFont * scale) : 12 / card.codeFont}
      frame={{ ...slot(card.codeHeight, lockScreen ? card.capsuleIcon : card.codeHeight),
        minWidth: 0, maxWidth: codeWidth, alignment: "leading" }}
      layoutPriority={lockScreen ? 2 : 1}>
      {pickupCode}
    </Text>
  );
  const artworkSticker = !stickerImage ? null : lockScreen && fitsHost ? (
    <HStack padding={{ horizontal: MIN_COMPACT_ART_WIDTH * (1 - stickerWidth / card.artWidth) / 2 }}
      offset={{ x: 0, y: (logoY - card.artHeight / 2) * scale }}>
      <Image {...stickerImage} resizable scaleToFit frame={{ maxWidth: logoSize, maxHeight: logoSize }} />
    </HStack>
  ) : (
    <Image {...stickerImage} resizable scaleToFit frame={{ width: logoSize, height: logoSize }}
      position={{ x: logoX * scale, y: logoY * scale }} />
  );
  const boxArtwork = (
    <ZStack frame={artworkFrame}
      offset={{ x: expanded ? -card.edge * scale : 0, y: artOffset }}>
      {artwork ? <ZStack scaleEffect={scale}>{artwork}</ZStack> : artworkImage ? (
        <Image {...artworkImage} resizable scaleToFit frame={artworkFrame} />
      ) : (
        <Image systemName={artworkSymbol} font={42 * scale} foregroundStyle={titleColor}
          resizable={fitsHost} scaleToFit={fitsHost}
          frame={fitsHost ? { maxWidth: 42 * scale, maxHeight: 42 * scale } : undefined} />
      )}
      {artworkSticker}
    </ZStack>
  );
  const artworkLabel = isMeal ? "切换冷热杯" : handoff ? "切换寄件渠道" : "切换取件站点";
  const appArtwork = onArtworkTap
    ? <Button buttonStyle="plain" accessibilityLabel={artworkLabel} action={onArtworkTap}>{boxArtwork}</Button>
    : boxArtwork;

  const capsuleControl = (label: VirtualNode) => {
    const priority = lockScreen ? undefined : 1;
    if (completion) return <Button intent={completion} buttonStyle="plain" layoutPriority={priority}>{label}</Button>;
    if (onComplete) {
      return <Button action={onComplete} buttonStyle="plain" disabled={actionPending} layoutPriority={priority}>{label}</Button>;
    }
    return label;
  };
  const actionAccessibility = { accessibilityLabel: completionLabel };
  const lockScreenAction = lockScreen && showCapsule ? (
    <HStack spacing={0} padding={{ trailing: card.edge * scale, bottom: card.edge * scale }}>
      {/* Only space beyond the regular card's code column belongs to the action. */}
      <Spacer minLength={0} frame={{ maxWidth: (card.width - card.edge - capsuleWidth) * scale }} layoutPriority={1} />
      {capsuleControl(
        <Rectangle {...actionAccessibility} fill="clear" frame={{ ...slot(card.capsuleHeight, card.capsuleHeight),
          minWidth: 0, maxWidth: capsuleWidth * scale }}
          background={{ alignment: "trailing", content: capsule }} clipped contentShape="capsule" />,
      )}
    </HStack>
  ) : undefined;
  const titleInset = titleTop - top - hostVerticalInset;
  const bottomInset = bottom - capsuleTop - card.capsuleHeight - hostVerticalInset;
  const title = onEditNote ? <Button buttonStyle="plain" action={onEditNote}>{titleRow}</Button> : titleRow;
  const location = onLocationTap ? <Button buttonStyle="plain" action={onLocationTap}>{subtitleRow}</Button> : subtitleRow;
  const expandedHeaderMinimum = card.titleLineHeight + gap + card.locationLineHeight + locationToDivider;
  // Use the Pipi line heights for leading while the outer boxes yield space to the gaps.
  const expandedLine = (content: VirtualNode, height: number, minimum: number, lineHeight = minimum) => (
    <Rectangle fill="clear" frame={{ ...slot(height, minimum), maxWidth: "infinity" }} layoutPriority={-2}
      overlay={{ alignment: "leading", content: (
        <VStack spacing={0} alignment="leading" fixedSize={{ horizontal: false, vertical: true }}
          frame={{ minHeight: lineHeight * verticalScale, alignment: "topLeading" }}>
          {content}
        </VStack>
      ) }} />
  );
  const divider = (
    <HStack spacing={0} frame={{ ...slot(card.dividerHeight, expanded ? card.dividerHeight : 0), maxWidth: "infinity" }}
      layoutPriority={lockScreen && fitsHost ? -1 : 0} clipped={fitsHost}>
      {dividerDots(card.width - card.textLeft - card.edge, verticalScale)}
    </HStack>
  );
  const supportingRows = (
    <>
      {space(gap)}
      {location}
      {space(locationToDivider)}
      {divider}
      {space(dividerToCapsule)}
    </>
  );
  const bottomRow = (
    <HStack spacing={fitsHost ? 0 : card.codeGap * scale}
      frame={{ ...actionRowHeight, maxWidth: "infinity", alignment: "leading" }}
      layoutPriority={fitsHost ? 1 : 0}>
      {onCopy ? <Button buttonStyle="plain" action={onCopy}>{code}</Button> : code}
      {fitsHost && !lockScreen ? <Spacer minLength={showCapsule ? card.codeGap * scale : 0} /> : null}
      {showCapsule && !lockScreen ? capsuleControl(capsule) : null}
    </HStack>
  );

  // Scripting snapshots Live Activities before the host proposes a layout size.
  const regular = (
    <HStack alignment="top" spacing={(card.textLeft - card.artWidth) * scale}
      frame={{ ...slot(bottom - top), minWidth: 0, maxWidth: "infinity", alignment: "topLeading" }}
      background={expanded ? undefined : cardBackground}
      activityBackgroundTint={lockScreen && !sharesSmartStack ? "clear" : undefined}
      clipShape={expanded || lockScreen ? undefined : cardShape}
      overlay={lockScreenAction ? { alignment: "bottomTrailing", content: lockScreenAction } : undefined}
      widgetURL={sharesSmartStack ? undefined : url} onTapGesture={onDetail} contentShape="rect">
      {fitsHost ? (
        // The expanded host supplies the card inset, so only the transparent artwork edge overlaps it.
        <Rectangle fill="clear" frame={{ ...slot(bottom - top),
          minWidth: expanded ? artColumnWidth : Math.min(artWidth, MIN_COMPACT_ART_WIDTH),
          idealWidth: artColumnWidth, maxWidth: artColumnWidth }}
          background={{ alignment: artworkAlignment, content: boxArtwork }}
          clipped layoutPriority={expanded ? 1 : -1} />
      ) : (
        <ZStack frame={{ width: artWidth, ...slot(bottom - top), alignment: artworkAlignment }}>{appArtwork}</ZStack>
      )}
      <VStack alignment="leading" spacing={0} padding={{ vertical: hostVerticalInset * scale,
        trailing: expanded ? 0 : card.edge * scale }}
        frame={{ ...slot(bottom - top), minWidth: 0,
          maxWidth: fitsHost && !expanded ? contentWidth : "infinity", alignment: "topLeading" }}
        layoutPriority={lockScreen && fitsHost ? 1 : 0}>
        {lockScreen ? <>
          {space(titleInset, 0, 0)}
          {title}
          <Rectangle fill="clear" frame={{ ...slot(capsuleTop - titleTop - card.titleHeight), maxWidth: "infinity" }}
            background={{ alignment: "topLeading", content: <VStack spacing={0} alignment="leading">{supportingRows}</VStack> }}
            clipped layoutPriority={-1} />
          {bottomRow}
          {space(bottomInset, 0, 0)}
        </> : expanded ? <>
          <VStack spacing={0} alignment="leading"
            frame={{ ...slot(dividerTop - titleTop, expandedHeaderMinimum), maxWidth: "infinity", alignment: "topLeading" }}>
            {expandedLine(title, card.titleHeight, card.titleLineHeight)}
            <Rectangle fill="clear" frame={slot(gap, gap)} />
            {expandedLine(location, card.locationHeight, card.locationLineHeight)}
            <Rectangle fill="clear" frame={slot(locationToDivider, locationToDivider)} />
          </VStack>
          <VStack spacing={dividerToCapsule * verticalScale} fixedSize={{ horizontal: false, vertical: true }} layoutPriority={1}>
            {divider}
            {bottomRow}
          </VStack>
        </> : <>
          {space(titleInset)}
          {title}
          {supportingRows}
          {bottomRow}
        </>}
      </VStack>
    </HStack>
  );

  if (!sharesSmartStack) return regular;

  const watchScale = SMART_STACK_ART_COLUMN_WIDTH / card.artWidth;
  const watchArtFrame = { width: SMART_STACK_ART_COLUMN_WIDTH, height: card.artHeight * watchScale };
  const watchStickerWidth = stickerWidth * watchScale;
  const watchBoxFile = hasWatchBox ? watchBoxPath : lockScreenBoxPath;
  const watchArtworkImage = watchBoxFile ? { filePath: watchBoxFile } : artworkImage;
  const watchContentWidth = SMART_STACK_MAX_WIDTH - SMART_STACK_ART_COLUMN_WIDTH - SMART_STACK_ART_GAP -
    SMART_STACK_TRAILING_INSET;
  const smartStack = (
    <HStack spacing={SMART_STACK_ART_GAP} padding={{ trailing: SMART_STACK_TRAILING_INSET }}
      frame={{ minWidth: 0, maxWidth: "infinity", maxHeight: "infinity" }}
      background={cardBackground} allowsHitTesting={false}>
      <ZStack frame={watchArtFrame} scaleEffect={SMART_STACK_ART_WIDTH / SMART_STACK_ART_COLUMN_WIDTH}>
        {watchArtworkImage ? <Image {...watchArtworkImage} resizable scaleToFit frame={watchArtFrame} />
          : <Image systemName={artworkSymbol} font={isMeal ? 42 * watchScale : 30} foregroundStyle={titleColor} />}
        {stickerImage ? <Image {...stickerImage} resizable scaleToFit frame={{ width: watchStickerWidth, height: watchStickerWidth }}
          position={{ x: logoX * watchScale, y: logoY * watchScale }} /> : null}
      </ZStack>
      <VStack alignment="leading" spacing={0}
        frame={{ minWidth: 0, maxWidth: "infinity", alignment: "leading" }}
        offset={{ x: 0, y: (SMART_STACK_ROW_GAP - card.iconGap) / 2 }}>
        <Text font={16} fontWeight="bold" foregroundStyle={titleColor} lineLimit={1} minScaleFactor={0.7}>{data.title}</Text>
        <HStack spacing={0} frame={{ minHeight: SMART_STACK_ROW_GAP, maxHeight: SMART_STACK_ROW_GAP, maxWidth: "infinity" }}
          offset={{ x: 0, y: SMART_STACK_DIVIDER_INK_OFFSET }}>
          {dividerDots(watchContentWidth, 1)}
        </HStack>
        <Text font={SMART_STACK_CODE_FONT} fontWeight="semibold" fontWidth="condensed" foregroundStyle={palette.code}
          kerning={0.4} lineLimit={1} allowsTightening minScaleFactor={11 / SMART_STACK_CODE_FONT}>{pickupCode}</Text>
      </VStack>
    </HStack>
  );

  // The native host proposes the mirrored width after Scripting snapshots the tree.
  // Reserve the Smart Stack width first. On the Lock Screen the remaining width
  // expands the mask across the entire card, above the smaller presentation.
  const regularMask = (
    <HStack spacing={0}>
      <Rectangle fill="clear" frame={{ minWidth: 0, maxWidth: SMART_STACK_MAX_WIDTH }} layoutPriority={1} />
      <ZStack scaleEffect={{ x: 4, y: 1, anchor: "trailing" }}>
        <Rectangle fill="white" frame={{ minWidth: 0, maxWidth: "infinity" }} />
      </ZStack>
    </HStack>
  );
  return (
    <ZStack background={{ alignment: "center", content: smartStack }} activityBackgroundTint="clear" widgetURL={url}>
      <ZStack mask={regularMask}>{regular}</ZStack>
    </ZStack>
  );
}
