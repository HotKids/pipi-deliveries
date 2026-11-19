import {
  GeometryReader, Image, Rectangle, Script, TimelineCanvas, VStack, ZStack,
  useEffect, useRef, useState,
} from "scripting";
import { PARCEL_ACTIVITY_PREVIEW, type ParcelActivityContent } from "../services/parcel-pickup";
import { parcelCardArtwork } from "../services/parcel-card-appearance";
import { MEAL_ARTWORK_FRAME_ENDS } from "../services/meal/artwork-motion.generated";
import { useBundledImage } from "./bundled-image";
import { ParcelLiveActivityCard, type ParcelLiveActivityCardProps, PIPI_CARD } from "./ParcelLiveActivityCard";
import { MEAL_ARTWORK_TOKENS, PICKUP_STICKER_ENTRANCE } from "./pickup-card-tokens.generated";

const { artWidth: ART_WIDTH, artHeight: ART_HEIGHT } = PIPI_CARD;
const ATLAS_COLUMNS = 7;
const FRAME_DURATION_MS = 33;
const CARD_ROW_SPACING = 16;
const BOX_IMAGE = "parcel-activity/box.png";

type ArtworkPlayback = {
  path: string;
  pixelScale: number;
  frameEnds: readonly number[];
  stickerDelay: number;
};

const BOX_PLAYBACK: ArtworkPlayback = {
  path: "parcel-activity/box-frames.png",
  pixelScale: 3,
  frameEnds: Array.from({ length: 43 }, (_, index) => (index + 1) * FRAME_DURATION_MS),
  stickerDelay: PICKUP_STICKER_ENTRANCE.parcelDelay,
};

function mealArtworkPlayback(art: { path: string; name: string }): ArtworkPlayback | undefined {
  const frameEnds = MEAL_ARTWORK_FRAME_ENDS[art.name];
  return frameEnds ? {
    path: art.path.replace(/\.png$/, "-frames.png"), pixelScale: 2,
    frameEnds, stickerDelay: PICKUP_STICKER_ENTRANCE.mealDelay,
  } : undefined;
}

let recentAtlas: { path: string; image?: UIImage | null; request: Promise<UIImage | null> } | undefined;

function loadArtworkAtlas(path: string): Promise<UIImage | null> {
  if (recentAtlas?.path === path) return recentAtlas.request;
  const entry: NonNullable<typeof recentAtlas> = {
    path,
    request: FileManager.readAsData(`${Script.directory}/assets/${path}`)
      .then((data) => UIImage.fromData(data)).catch(() => null).then((image) => {
        entry.image = image;
        return image;
      }),
  };
  recentAtlas = entry;
  return entry.request;
}

function stickerEase(progress: number): number {
  if (progress >= 1) return 1;
  // Same cubic Bézier as Pipi's sticker, with Y = t³.
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 10; iteration++) {
    const t = (low + high) / 2;
    const x = 3 * (1 - t) * t * (PICKUP_STICKER_ENTRANCE.curveX1 * (1 - t) + PICKUP_STICKER_ENTRANCE.curveX2 * t) + t ** 3;
    if (x < progress) low = t;
    else high = t;
  }
  return ((low + high) / 2) ** 3;
}

function stickerRotation(elapsed: number): number {
  const { rotationIntervals, rotationDegrees } = PICKUP_STICKER_ENTRANCE;
  for (const [index, duration] of rotationIntervals.entries()) {
    if (elapsed < duration) {
      const from = rotationDegrees[index];
      const to = rotationDegrees[index + 1];
      return (from + (to - from) * stickerEase(elapsed / duration)) * Math.PI / 180;
    }
    elapsed -= duration;
  }
  return 0;
}

type StickerPlacement = { logoSize: number; logoX: number; logoY: number };

function AnimatedPickupArtwork({ atlas, playback, logo, logoSize, logoX, logoY }: StickerPlacement & {
  atlas: UIImage; playback: ArtworkPlayback; logo: UIImage | null;
}) {
  const [settled, setSettled] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const stopTimer = () => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  };
  useEffect(() => stopTimer, []);
  const { frameEnds, pixelScale, stickerDelay } = playback;
  const lastFrame = frameEnds.length - 1;
  const finishAt = Math.max(frameEnds[lastFrame], logo ? stickerDelay + PICKUP_STICKER_ENTRANCE.duration : 0);
  const width = ART_WIDTH * pixelScale;
  const height = ART_HEIGHT * pixelScale;
  const stickerX = logoX - logoSize / 2;
  const stickerY = logoY - logoSize / 2;
  const { pivotX, pivotY, alphaDuration } = PICKUP_STICKER_ENTRANCE;
  return (
    <TimelineCanvas frame={{ width: ART_WIDTH, height: ART_HEIGHT }} opaque={false}
      paused={settled}
      schedule={{ minimumInterval: FRAME_DURATION_MS / 1000 }}
      onAppear={() => {
        stopTimer();
        // Keep the terminal frame on the same canvas while the sticker settles.
        timer.current = setTimeout(() => setSettled(true), finishAt + FRAME_DURATION_MS);
      }}
      onDisappear={stopTimer}
      draw={(ctx, _, seconds) => {
        const elapsed = Math.max(0, seconds * 1000);
        const frame = elapsed >= frameEnds[lastFrame] ? lastFrame : frameEnds.findIndex(end => elapsed < end);
        ctx.drawImage({ image: atlas }, frame % ATLAS_COLUMNS * width, Math.floor(frame / ATLAS_COLUMNS) * height,
          width, height, 0, 0, ART_WIDTH, ART_HEIGHT);
        if (logo && elapsed >= stickerDelay) {
          const entrance = elapsed - stickerDelay;
          ctx.save();
          ctx.globalAlpha = stickerEase(entrance / alphaDuration);
          ctx.translate(stickerX + pivotX, stickerY + pivotY);
          ctx.rotate(stickerRotation(entrance));
          ctx.drawImage({ image: logo }, -pivotX, -pivotY, logoSize, logoSize);
          ctx.restore();
        }
      }}
    />
  );
}

function PickupTabArtwork({ baseAsset, logoAsset, logoSize, logoX, logoY, playback }: StickerPlacement & {
  baseAsset: string; logoAsset?: string; playback?: ArtworkPlayback;
}) {
  const [appearance, setAppearance] = useState(0);
  const [atlas, setAtlas] = useState(playback && recentAtlas?.path === playback.path ? recentAtlas.image : undefined);
  const hasAppeared = useRef(false);
  const visible = useRef(false);
  useEffect(() => () => { visible.current = false; }, []);
  const logo = useBundledImage(logoAsset) ?? null;
  const still = useBundledImage(atlas ? undefined : baseAsset);
  return (
    <ZStack alignment="topLeading" frame={{ width: ART_WIDTH, height: ART_HEIGHT }}
      onAppear={playback ? () => {
        visible.current = true;
        if (atlas === undefined) void loadArtworkAtlas(playback.path).then((image) => {
          if (visible.current) setAtlas(image);
        });
        if (hasAppeared.current) setAppearance((visit) => visit + 1);
        hasAppeared.current = true;
      } : undefined}
      onDisappear={() => { visible.current = false; }}>
      {atlas && playback ? <AnimatedPickupArtwork key={appearance} atlas={atlas}
        playback={playback} logo={logo} logoSize={logoSize} logoX={logoX} logoY={logoY} /> : (
        <ZStack alignment="topLeading">
          {still ? <Image image={still} resizable scaleToFit frame={{ width: ART_WIDTH, height: ART_HEIGHT }} /> : null}
          {logo ? <Image image={logo} resizable scaleToFit frame={{ width: logoSize, height: logoSize }}
            offset={{ x: logoX - logoSize / 2, y: logoY - logoSize / 2 }} /> : null}
        </ZStack>
      )}
    </ZStack>
  );
}

function ParcelCardListRow({ spaceAfter, ...cardProps }: ParcelLiveActivityCardProps & { spaceAfter?: boolean }) {
  const [width, setWidth] = useState<number>(PIPI_CARD.width);
  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity" }} listRowInsets={0}
      padding={spaceAfter ? { bottom: CARD_ROW_SPACING } : undefined}
      listRowBackground={<Rectangle fill="clear" />} listRowSeparator="hidden"
      background={
        <GeometryReader>
          {({ size }) => (
            <Rectangle fill="clear" key={Math.round(size.width)} allowsHitTesting={false}
              onAppear={() => { if (size.width > 0) setWidth(size.width); }} />
          )}
        </GeometryReader>
      }>
      <ParcelLiveActivityCard {...cardProps} width={width} />
    </VStack>
  );
}

export function ParcelActivityPreviewCard({ animate = false }: { animate?: boolean }) {
  const { sticker } = parcelCardArtwork(PARCEL_ACTIVITY_PREVIEW);
  const logoPath = sticker ? `${Script.directory}/assets/${sticker.path}` : undefined;
  return (
    <ParcelCardListRow data={PARCEL_ACTIVITY_PREVIEW} imageRoot={`${Script.directory}/assets/parcel-activity`}
      logoPath={logoPath} preview
      artwork={animate ? <PickupTabArtwork baseAsset={BOX_IMAGE}
        logoAsset={sticker?.path} logoSize={26} logoX={PIPI_CARD.logoX} logoY={PIPI_CARD.logoY} playback={BOX_PLAYBACK} />
        : undefined} />
  );
}

export function PickupTabCard(props: {
  data: ParcelActivityContent;
  animate: boolean;
  spaceAfter: boolean;
  title: string;
  onCopy?: () => void;
  onComplete?: () => void;
  onDetail?: () => void;
  onEditNote?: () => void;
  actionPending: boolean;
  actionLabel?: string;
  locationText?: string;
  showingAddress?: boolean;
  onLocationTap?: () => void;
  onArtworkTap?: () => void;
}) {
  const { data, animate, spaceAfter, ...cardProps } = props;
  const isMeal = data.kind === "meal";
  const { logoX, logoY } = isMeal ? MEAL_ARTWORK_TOKENS : PIPI_CARD;
  const logoSize = isMeal ? MEAL_ARTWORK_TOKENS.stickerSize * (data.mealStyle?.stickerScale ?? 1)
    : data.kind === "handoff" ? 20 : 26;
  const imageRoot = `${Script.directory}/assets/parcel-activity`;
  const { meal, mealSticker, sticker } = parcelCardArtwork(data);
  const baseAsset = isMeal ? meal?.path : BOX_IMAGE;
  const playback = animate ? isMeal ? meal && mealArtworkPlayback(meal) : BOX_PLAYBACK : undefined;
  return (
    <ParcelCardListRow {...cardProps} data={{ ...data, title: props.title }} imageRoot={imageRoot} spaceAfter={spaceAfter}
      artwork={baseAsset ? <PickupTabArtwork key={playback?.path ?? baseAsset} baseAsset={baseAsset}
        logoAsset={isMeal ? mealSticker?.path : sticker?.path} logoSize={logoSize}
        logoX={logoX} logoY={logoY} playback={playback} /> : undefined} />
  );
}
