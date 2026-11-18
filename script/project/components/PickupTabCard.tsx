import {
  GeometryReader, Image, Rectangle, Script, TimelineCanvas, VStack, ZStack,
  useEffect, useMemo, useRef, useState,
} from "scripting";
import { PARCEL_ACTIVITY_PREVIEW, type ParcelActivityContent } from "../services/parcel-pickup";
import { parcelCardArtwork } from "../services/parcel-card-appearance";
import { bundledImage } from "./bundled-image";
import { ParcelLiveActivityCard, type ParcelLiveActivityCardProps, PIPI_CARD } from "./ParcelLiveActivityCard";

const ART_WIDTH = 100;
const ART_HEIGHT = 117;
const ATLAS_COLUMNS = 7;
const ATLAS_SCALE = 3;
const FRAME_COUNT = 43;
const FRAME_DURATION_MS = 33;
const STICKER_DELAY_MS = 1250;
const STICKER_ALPHA_MS = 500;
const STICKER_ROTATION_MS = [183, 200, 150, 67];
const STICKER_ROTATION_DEGREES = [4, -4, 3, -1, 0];
const STICKER_DURATION_MS = STICKER_ROTATION_MS.reduce((sum, duration) => sum + duration, 0);
let boxAtlas: UIImage | null | undefined;

function stickerEase(progress: number): number {
  if (progress >= 1) return 1;
  // Same cubic Bézier as Pipi's sticker, with Y = t³.
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 10; iteration++) {
    const t = (low + high) / 2;
    const x = 3 * (1 - t) * t * (0.33 * (1 - t) + 0.67 * t) + t ** 3;
    if (x < progress) low = t;
    else high = t;
  }
  return ((low + high) / 2) ** 3;
}

function stickerRotation(elapsed: number): number {
  for (const [index, duration] of STICKER_ROTATION_MS.entries()) {
    if (elapsed < duration) {
      const from = STICKER_ROTATION_DEGREES[index];
      const to = STICKER_ROTATION_DEGREES[index + 1];
      return (from + (to - from) * stickerEase(elapsed / duration)) * Math.PI / 180;
    }
    elapsed -= duration;
  }
  return 0;
}

function AnimatedBox({ atlas, logo, logoSize }: { atlas: UIImage; logo: UIImage | null; logoSize: number }) {
  const [settled, setSettled] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const stopTimer = () => {
    if (timer.current !== undefined) clearTimeout(timer.current);
    timer.current = undefined;
  };
  useEffect(() => stopTimer, []);
  const finishAt = logo ? STICKER_DELAY_MS + STICKER_DURATION_MS : FRAME_COUNT * FRAME_DURATION_MS;
  const width = ART_WIDTH * ATLAS_SCALE;
  const height = ART_HEIGHT * ATLAS_SCALE;
  const stickerX = 50 - logoSize / 2;
  const stickerY = 64 - logoSize / 2;
  return (
    <TimelineCanvas frame={{ width: ART_WIDTH, height: ART_HEIGHT }} opaque={false}
      paused={settled}
      schedule={{ minimumInterval: FRAME_DURATION_MS / 1000 }}
      onAppear={() => {
        stopTimer();
        // Keep the last box frame on the same canvas while the sticker settles.
        timer.current = setTimeout(() => setSettled(true), finishAt + FRAME_DURATION_MS);
      }}
      onDisappear={stopTimer}
      draw={(ctx, _, seconds) => {
        const elapsed = Math.max(0, seconds * 1000);
        const frame = Math.min(FRAME_COUNT - 1, Math.floor(elapsed / FRAME_DURATION_MS));
        ctx.drawImage({ image: atlas }, frame % ATLAS_COLUMNS * width, Math.floor(frame / ATLAS_COLUMNS) * height,
          width, height, 0, 0, ART_WIDTH, ART_HEIGHT);
        if (logo && elapsed >= STICKER_DELAY_MS) {
          const entrance = elapsed - STICKER_DELAY_MS;
          ctx.save();
          ctx.globalAlpha = stickerEase(entrance / STICKER_ALPHA_MS);
          ctx.translate(stickerX + 12, stickerY + 47);
          ctx.rotate(stickerRotation(entrance));
          ctx.drawImage({ image: logo }, -12, -47, logoSize, logoSize);
          ctx.restore();
        }
      }}
    />
  );
}

function PickupTabArtwork({ logoAsset, logoSize }: { logoAsset?: string; logoSize: number }) {
  const [appearance, setAppearance] = useState(0);
  const hasAppeared = useRef(false);
  const root = `${Script.directory}/assets/parcel-activity`;
  if (boxAtlas === undefined) boxAtlas = UIImage.fromFile(root + "/box-frames.png");
  const logo = useMemo(() => logoAsset ? bundledImage(logoAsset) ?? null : null, [logoAsset]);
  const box = bundledImage("parcel-activity/box.png");
  return (
    <ZStack alignment="topLeading" frame={{ width: ART_WIDTH, height: ART_HEIGHT }}
      onAppear={() => {
        if (hasAppeared.current) setAppearance((visit) => visit + 1);
        hasAppeared.current = true;
      }}>
      {boxAtlas ? <AnimatedBox key={appearance} atlas={boxAtlas} logo={logo} logoSize={logoSize} /> : (
        <ZStack alignment="topLeading">
          {box ? <Image image={box} resizable scaleToFit frame={{ width: ART_WIDTH, height: ART_HEIGHT }} /> : null}
          {logo ? <Image image={logo} resizable scaleToFit frame={{ width: logoSize, height: logoSize }}
            offset={{ x: 50 - logoSize / 2, y: 64 - logoSize / 2 }} /> : null}
        </ZStack>
      )}
    </ZStack>
  );
}

function ParcelCardListRow(props: ParcelLiveActivityCardProps) {
  const [width, setWidth] = useState<number>(PIPI_CARD.width);
  return (
    <VStack spacing={0} frame={{ maxWidth: "infinity" }} listRowInsets={0}
      listRowBackground={<Rectangle fill="clear" />} listRowSeparator="hidden"
      background={
        <GeometryReader>
          {({ size }) => (
            <Rectangle fill="clear" key={Math.round(size.width)} allowsHitTesting={false}
              onAppear={() => { if (size.width > 0) setWidth(size.width); }} />
          )}
        </GeometryReader>
      }>
      <ParcelLiveActivityCard {...props} width={width} />
    </VStack>
  );
}

export function ParcelActivityPreviewCard({ animate = false }: { animate?: boolean }) {
  const { sticker } = parcelCardArtwork(PARCEL_ACTIVITY_PREVIEW);
  const logoPath = sticker ? `${Script.directory}/assets/${sticker.path}` : undefined;
  return (
    <ParcelCardListRow data={PARCEL_ACTIVITY_PREVIEW} imageRoot={`${Script.directory}/assets/parcel-activity`}
      logoPath={logoPath} preview
      artwork={animate ? <PickupTabArtwork logoAsset={sticker?.path} logoSize={26} /> : undefined} />
  );
}

export function PickupTabCard(props: {
  data: ParcelActivityContent;
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
}) {
  const { data } = props;
  const handoff = data.kind === "handoff";
  const logoSize = handoff ? 20 : 26;
  const imageRoot = `${Script.directory}/assets/parcel-activity`;
  const { sticker } = parcelCardArtwork(data);
  return (
    <ParcelCardListRow {...props} data={{ ...data, title: props.title }} imageRoot={imageRoot}
      artwork={<PickupTabArtwork logoAsset={sticker?.path} logoSize={logoSize} />} />
  );
}
