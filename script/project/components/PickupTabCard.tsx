import {
  Button, GeometryReader, Image, Rectangle, Script, TimelineCanvas, VStack, ZStack,
  useEffect, useRef, useState,
} from "scripting";
import { PARCEL_ACTIVITY_PREVIEW, type ParcelActivityContent } from "../services/parcel-pickup";
import { parcelCardArtwork, PICKUP_CARD_SPACING, type ParcelLockScreenStyle } from "../services/parcel-card-appearance";
import { MEAL_ARTWORK_FRAME_ENDS } from "../services/meal/artwork-motion.generated";
import { bundledImage, prewarmBundledImages } from "./bundled-image";
import { ParcelLiveActivityCard, type ParcelLiveActivityCardProps, PIPI_CARD } from "./ParcelLiveActivityCard";
import { MEAL_ARTWORK_TOKENS, PICKUP_STICKER_ENTRANCE } from "./pickup-card-tokens.generated";

const { artWidth: ART_WIDTH, artHeight: ART_HEIGHT } = PIPI_CARD;
const ATLAS_COLUMNS = 7;
const FRAME_DURATION_MS = 33;
const PLAYBACK_START_DELAY_MS = 200;
const BOX_IMAGE = "parcel-activity/box.png";

type ArtworkPlayback = {
  path: string;
  pixelScale: number;
  frameEnds: readonly number[];
  stickerDelay: number;
  firstVisibleFrame?: number;
};

const BOX_PLAYBACK: ArtworkPlayback = {
  path: "parcel-activity/box-frames.png",
  pixelScale: 3,
  frameEnds: Array.from({ length: 43 }, (_, index) => (index + 1) * FRAME_DURATION_MS),
  stickerDelay: PICKUP_STICKER_ENTRANCE.parcelDelay,
  // Frames 0..6 in box-frames.png are transparent lead-in frames; start handoff at the first visible box frame.
  firstVisibleFrame: 7,
};

function mealArtworkPlayback(art: { path: string; name: string }): ArtworkPlayback | undefined {
  const frameEnds = MEAL_ARTWORK_FRAME_ENDS[art.name];
  return frameEnds ? {
    path: art.path.replace(/\.png$/, "-frames.png"), pixelScale: 2,
    frameEnds, stickerDelay: PICKUP_STICKER_ENTRANCE.mealDelay,
  } : undefined;
}

// The last four animation atlases stay decoded (G-LOW-13), most recently used last, so moving between a few cards
// does not read and decode an atlas again. A load that failed stays cached like before, until it is evicted.
const ATLAS_CACHE_SLOTS = 4;
type AtlasEntry = { image?: UIImage | null; request: Promise<UIImage | null> };
const recentAtlases = new Map<string, AtlasEntry>();

function touchAtlas(path: string): AtlasEntry | undefined {
  const entry = recentAtlases.get(path);
  if (entry) {
    recentAtlases.delete(path);
    recentAtlases.set(path, entry);
  }
  return entry;
}

/** The decoded atlas already loaded for `path` (null when its load failed), or undefined. */
function cachedArtworkAtlas(path: string): UIImage | null | undefined {
  return touchAtlas(path)?.image;
}

function loadArtworkAtlas(path: string): Promise<UIImage | null> {
  const cached = touchAtlas(path);
  if (cached) return cached.request;
  const entry: AtlasEntry = {
    request: FileManager.readAsData(`${Script.directory}/assets/${path}`)
      .then((data) => UIImage.fromData(data)).catch(() => null).then((image) => {
        entry.image = image;
        return image;
      }),
  };
  recentAtlases.set(path, entry);
  while (recentAtlases.size > ATLAS_CACHE_SLOTS) {
    const eldest = recentAtlases.keys().next().value;
    if (eldest === undefined) break;
    recentAtlases.delete(eldest);
  }
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
type PickupArtwork = StickerPlacement & { baseAsset: string; logoAsset?: string; playback?: ArtworkPlayback };

function AnimatedPickupArtwork({ atlas, playback, logo, logoSize, logoX, logoY, onFirstVisibleFrame }: StickerPlacement & {
  atlas: UIImage; playback: ArtworkPlayback; logo: UIImage | null; onFirstVisibleFrame: () => void;
}) {
  const [settled, setSettled] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const handoffTimer = useRef<number | undefined>(undefined);
  const notifiedVisible = useRef(false);
  const stopTimer = () => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
    if (handoffTimer.current !== undefined) clearTimeout(handoffTimer.current);
    handoffTimer.current = undefined;
  };
  useEffect(() => stopTimer, []);
  const { frameEnds, pixelScale, stickerDelay, firstVisibleFrame = 0 } = playback;
  const startOffsetMs = firstVisibleFrame > 0 ? (frameEnds[firstVisibleFrame - 1] ?? firstVisibleFrame * FRAME_DURATION_MS) : 0;
  const lastFrame = frameEnds.length - 1;
  const finishAt = Math.max(
    0,
    Math.max(frameEnds[lastFrame], logo ? stickerDelay + PICKUP_STICKER_ENTRANCE.duration : 0) - startOffsetMs,
  );
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
        const elapsed = Math.max(0, seconds * 1000) + startOffsetMs;
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
        if (!notifiedVisible.current && frame >= firstVisibleFrame) {
          notifiedVisible.current = true;
          handoffTimer.current = setTimeout(() => {
            handoffTimer.current = undefined;
            onFirstVisibleFrame();
          }, 0);
        }
      }}
    />
  );
}

export function prewarmPickupTabAssets(cards: readonly ParcelActivityContent[], previewing = false): Promise<void> {
  const paths: Array<string | undefined> = [BOX_IMAGE];
  if (previewing) {
    paths.push(parcelCardArtwork(PARCEL_ACTIVITY_PREVIEW).sticker?.path);
  }
  for (const card of cards.slice(0, 8)) {
    const { meal, mealSticker, sticker, mark } = parcelCardArtwork(card);
    paths.push(card.kind === "meal" ? meal?.path : BOX_IMAGE);
    paths.push(card.kind === "meal" ? mealSticker?.path : sticker?.path);
    paths.push(mark?.path);
  }
  return prewarmBundledImages(paths);
}

function PickupTabArtwork({ baseAsset, logoAsset, logoSize, logoX, logoY, playback, autoPlay, playOnMount, replayRequest }: PickupArtwork & {
  autoPlay: boolean; playOnMount: boolean; replayRequest: number;
}) {
  const [appearance, setAppearance] = useState(0);
  const [atlas, setAtlas] = useState(playback ? cachedArtworkAtlas(playback.path) : undefined);
  const [playbackReady, setPlaybackReady] = useState(false);
  const [canvasHandedOff, setCanvasHandedOff] = useState(false);
  const hasAppeared = useRef(false);
  const visible = useRef(playOnMount);
  const startTimer = useRef<number | undefined>(undefined);
  const playbackGeneration = useRef(0);
  const cancelPlaybackStart = () => {
    playbackGeneration.current += 1;
    if (startTimer.current !== undefined) clearTimeout(startTimer.current);
    startTimer.current = undefined;
  };
  function startPlayback(immediate = false) {
    if (!playback) return;
    if (startTimer.current !== undefined) {
      if (!immediate) return;
      cancelPlaybackStart();
    }
    const generation = ++playbackGeneration.current;
    const begin = () => {
      startTimer.current = undefined;
      if (!visible.current || generation !== playbackGeneration.current) return;
      const activate = (loadedAtlas: UIImage | null) => {
        if (!visible.current || generation !== playbackGeneration.current) return;
        setAtlas(loadedAtlas);
        if (!loadedAtlas) return;
        setCanvasHandedOff(false);
        if (hasAppeared.current) setAppearance((visit) => visit + 1);
        hasAppeared.current = true;
        setPlaybackReady(true);
      };
      const warm = cachedArtworkAtlas(playback.path);
      if (warm !== undefined) activate(warm);
      else void loadArtworkAtlas(playback.path).then(activate);
    };
    if (immediate) begin();
    else startTimer.current = setTimeout(begin, PLAYBACK_START_DELAY_MS);
  }
  useEffect(() => {
    if (playOnMount) visible.current = true;
    return () => {
      visible.current = false;
      cancelPlaybackStart();
    };
  }, [playOnMount]);
  useEffect(() => {
    if (!autoPlay || !playback) {
      cancelPlaybackStart();
      setPlaybackReady(false);
      setCanvasHandedOff(false);
      return;
    }
    if (visible.current) startPlayback();
  }, [autoPlay, playback?.path]);
  useEffect(() => {
    if (replayRequest > 0 && visible.current) startPlayback(true);
  }, [replayRequest]);
  const logo = bundledImage(logoAsset) ?? null;
  const showCanvas = Boolean(playbackReady && atlas && playback);
  const keepStaticUnderlay = !showCanvas || !canvasHandedOff;
  const still = keepStaticUnderlay ? bundledImage(baseAsset) : undefined;
  const showStaticSticker = Boolean(logo && (!autoPlay || !playback || atlas === null));
  return (
    <ZStack alignment="topLeading" frame={{ width: ART_WIDTH, height: ART_HEIGHT }}
      onAppear={!playOnMount ? () => {
        visible.current = true;
        if (autoPlay && playback) startPlayback();
      } : undefined}
      onDisappear={!playOnMount ? () => {
        visible.current = false;
        cancelPlaybackStart();
        if (playback) {
          setPlaybackReady(false);
          setCanvasHandedOff(false);
        }
      } : undefined}>
      {keepStaticUnderlay ? (
        <ZStack alignment="topLeading">
          {still ? <Image image={still} resizable scaleToFit frame={{ width: ART_WIDTH, height: ART_HEIGHT }} /> : null}
          {showStaticSticker && logo ? <Image image={logo} resizable scaleToFit frame={{ width: logoSize, height: logoSize }}
            offset={{ x: logoX - logoSize / 2, y: logoY - logoSize / 2 }} /> : null}
        </ZStack>
      ) : null}
      {showCanvas && atlas && playback ? <AnimatedPickupArtwork key={appearance} atlas={atlas}
        playback={playback} logo={logo} logoSize={logoSize} logoX={logoX} logoY={logoY}
        onFirstVisibleFrame={() => setCanvasHandedOff(true)} /> : null}
    </ZStack>
  );
}

function ParcelCardListRow({ spaceAfter, width: containerWidth, art, animate, deleteAction, ...cardProps }: Omit<ParcelLiveActivityCardProps, "artwork"> & {
  spaceAfter?: boolean; art?: PickupArtwork; animate: boolean;
  deleteAction?: { title: string; onDelete: () => void };
}) {
  const [width, setWidth] = useState<number>(PIPI_CARD.width);
  const [replayRequest, setReplayRequest] = useState(0);
  const replay = !cardProps.onArtworkTap && art?.playback
    ? () => setReplayRequest(value => value + 1) : undefined;
  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity" }} listRowInsets={0}
      padding={spaceAfter ? { bottom: PICKUP_CARD_SPACING } : undefined}
      listRowBackground={<Rectangle fill="clear" />} listRowSeparator="hidden"
      contextMenu={deleteAction ? {
        menuItems: (
          <Button role="destructive" title={deleteAction.title} systemImage="trash" action={deleteAction.onDelete} />
        ),
      } : undefined}
      background={containerWidth === undefined ? (
        <GeometryReader>
          {({ size }) => (
            <Rectangle fill="clear" key={Math.round(size.width)} allowsHitTesting={false}
              onAppear={() => { if (size.width > 0) setWidth(size.width); }} />
          )}
        </GeometryReader>
      ) : undefined}>
      <ParcelLiveActivityCard {...cardProps} width={containerWidth ?? width}
        onArtworkTap={cardProps.onArtworkTap ?? replay}
        artworkActionLabel={replay ? "重播商品动画" : undefined}
        artwork={art ? <PickupTabArtwork key={`${art.baseAsset}:${art.playback?.path ?? ""}`}
          {...art} autoPlay={animate} replayRequest={replay ? replayRequest : 0}
          playOnMount={containerWidth !== undefined} /> : undefined} />
    </VStack>
  );
}

export function ParcelActivityPreviewCard({ animate = false, lockScreenStyle, onComplete, actionPending }: {
  animate?: boolean; lockScreenStyle?: ParcelLockScreenStyle;
  onComplete?: () => void; actionPending?: boolean;
}) {
  const { sticker } = parcelCardArtwork(PARCEL_ACTIVITY_PREVIEW);
  return (
    <ParcelCardListRow data={PARCEL_ACTIVITY_PREVIEW} imageRoot={`${Script.directory}/assets/parcel-activity`}
      preview lockScreenStyle={lockScreenStyle} animate={animate}
      onComplete={onComplete} actionPending={actionPending}
      art={{ baseAsset: BOX_IMAGE, logoAsset: sticker?.path, logoSize: 26,
        logoX: PIPI_CARD.logoX, logoY: PIPI_CARD.logoY, playback: BOX_PLAYBACK }} />
  );
}

export function PickupTabCard(props: {
  data: ParcelActivityContent;
  animate: boolean;
  spaceAfter: boolean;
  width?: number;
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
  deleteAction?: { title: string; onDelete: () => void };
}) {
  const { data, animate, spaceAfter, ...cardProps } = props;
  const isMeal = data.kind === "meal";
  const { logoX, logoY } = isMeal ? MEAL_ARTWORK_TOKENS : PIPI_CARD;
  const logoSize = isMeal ? MEAL_ARTWORK_TOKENS.stickerSize * (data.mealStyle?.stickerScale ?? 1)
    : data.kind === "handoff" ? 20 : 26;
  const imageRoot = `${Script.directory}/assets/parcel-activity`;
  const { meal, mealSticker, sticker } = parcelCardArtwork(data);
  const baseAsset = isMeal ? meal?.path : BOX_IMAGE;
  const playback = isMeal ? meal && mealArtworkPlayback(meal) : BOX_PLAYBACK;
  return (
    <ParcelCardListRow {...cardProps} data={{ ...data, title: props.title }} imageRoot={imageRoot}
      spaceAfter={spaceAfter} animate={animate}
      art={baseAsset ? { baseAsset, logoAsset: isMeal ? mealSticker?.path : sticker?.path,
        logoSize, logoX, logoY, playback } : undefined} />
  );
}
