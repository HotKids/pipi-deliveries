import { Button, Circle, HStack, Image, Rectangle, Script, Spacer, Text, VStack, ZStack, gradient, type AppIntent, type VirtualNode } from "scripting";
import type { ParcelActivityCompletion } from "../services/parcel-activity-action";
import { PARCEL_ACTIVITY_PREVIEW, parcelPickupShortCode, parcelPickupSubtitle, type ParcelActivityContent } from "../services/parcel-pickup";

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
  dotDiameter: 2.7,
  dotGap: 3.8,
  capsuleHeight: 35,
  capsuleInset: 11,
  capsuleIcon: 19,
  iconGap: 4,
  codeGap: 8,
} as const;

export function parcelActivityImage(path?: string): UIImage | null {
  if (!path) return null;
  try { return UIImage.fromFile(path); } catch { return null; }
}

export function ParcelActivityPreviewCard() {
  const imageRoot = `${Script.directory}/assets/parcel-activity`;
  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity" }}
      listRowInsets={0} listRowBackground={<Rectangle fill="clear" />} listRowSeparator="hidden">
      <ParcelLiveActivityCard data={PARCEL_ACTIVITY_PREVIEW} imageRoot={imageRoot}
        logoPath={`${imageRoot}/cainiao.png`} preview />
    </VStack>
  );
}

export function ParcelLiveActivityCard({ data, imageRoot, logoPath, url, completion, preview, expanded, artwork,
  actionIcon, actionLabel, actionPending, locationText, showingAddress, onComplete, onCopy, onDetail, onEditNote, onLocationTap }: {
  data: ParcelActivityContent;
  imageRoot: string;
  logoPath?: string;
  url?: string;
  completion?: AppIntent<ParcelActivityCompletion>;
  preview?: boolean;
  expanded?: boolean;
  artwork?: VirtualNode;
  actionIcon?: VirtualNode;
  actionLabel?: string;
  actionPending?: boolean;
  locationText?: string;
  showingAddress?: boolean;
  onComplete?: () => void;
  onCopy?: () => void;
  onDetail?: () => void;
  onEditNote?: () => void;
  onLocationTap?: () => void;
}) {
  const card = PIPI_CARD;
  const handoff = data.kind === "handoff";
  const logoSize = handoff ? 20 : 26;
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
    <HStack spacing={card.iconGap} padding={{ horizontal: card.capsuleInset }}
      frame={{ height: card.capsuleHeight }} fixedSize={{ horizontal: true, vertical: false }}
      background={{ style: "rgba(255,255,255,0.16)", shape: "capsule" }} contentShape="capsule">
      {actionIcon ?? <Image systemName="shippingbox.fill" font={card.capsuleIcon} foregroundStyle="white" />}
      <Text font={12} fontWeight="semibold" foregroundStyle="white" lineLimit={1}>{completionLabel}</Text>
    </HStack>
  );
  const titleRow = (
    <Text font={15} fontWeight="bold" foregroundStyle="rgba(255,255,255,0.9)" lineLimit={1}
      frame={{ height: card.titleHeight, alignment: "leading" }}>{data.title}</Text>
  );
  const subtitleRow = (
    <HStack spacing={card.iconGap} frame={{ height: card.locationHeight, alignment: "leading" }}>
      {subtitle.text ? <>
        <Image systemName={subtitle.symbol} font={13} foregroundStyle="rgba(255,255,255,0.85)" />
        <Text font={11} foregroundStyle="rgba(255,255,255,0.85)" lineLimit={1}>{subtitle.text}</Text>
      </> : null}
    </HStack>
  );
  const code = (
    <Text font={28} fontWeight="semibold" foregroundStyle="white" monospacedDigit lineLimit={1}
      minScaleFactor={12 / 28} frame={{ minWidth: 0, maxWidth: "infinity", alignment: "leading" }}>
      {parcelPickupShortCode(data.code)}
    </Text>
  );

  // Scripting snapshots Live Activities before the host proposes a layout size.
  return (
    <HStack alignment="center" spacing={card.textLeft - card.artWidth}
      frame={{ height: card.height, maxWidth: "infinity" }}
      background={expanded ? undefined : gradient("linear", {
        colors: ["#22262D", "#38232D"], startPoint: "leading", endPoint: "trailing",
      })}
      activityBackgroundTint={expanded ? undefined : "clear"}
      clipShape={expanded ? undefined : { type: "rect", cornerRadius: card.corner }}
      widgetURL={url} onTapGesture={onDetail} contentShape="rect">
      <ZStack frame={{ width: card.artWidth, height: card.artHeight }}
        offset={{ x: 0, y: card.artTop - (card.height - card.artHeight) / 2 }}>
        {artwork ?? (box ? (
          <Image image={box} resizable scaleToFit frame={{ width: card.artWidth, height: card.artHeight }} />
        ) : (
          <Image systemName="shippingbox.fill" font={42} foregroundStyle="white" />
        ))}
        {logo ? (
          <Image image={logo} resizable scaleToFit frame={{ width: logoSize, height: logoSize }}
            position={{ x: card.logoX, y: card.logoY - card.artTop }} />
        ) : null}
      </ZStack>
      <VStack alignment="leading" spacing={0} padding={{ top: titleTop, bottom: card.edge, trailing: card.edge }}
        frame={{ minWidth: 0, maxWidth: "infinity", height: card.height, alignment: "leading" }}>
        {onEditNote ? <Button buttonStyle="plain" action={onEditNote}>{titleRow}</Button> : titleRow}
        <VStack alignment="leading" spacing={0} padding={{ top: gap }}>
          {onLocationTap ? <Button buttonStyle="plain" action={onLocationTap}>{subtitleRow}</Button> : subtitleRow}
        </VStack>
        <HStack spacing={0} frame={{ maxWidth: "infinity", height: card.dividerHeight }}
          padding={{ top: dividerTop - locationTop - card.locationHeight }}>
          {Array.from({ length: dotCount }, (_, index) => (
            <HStack key={index} spacing={0} frame={index > 0 ? { maxWidth: "infinity", alignment: "trailing" } : undefined}>
              <Circle fill="rgba(255,255,255,0.18)" frame={{ width: card.dotDiameter, height: card.dotDiameter }} />
            </HStack>
          ))}
        </HStack>
        <Spacer minLength={0} />
        <HStack spacing={card.codeGap} frame={{ maxWidth: "infinity", height: card.capsuleHeight }}>
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
