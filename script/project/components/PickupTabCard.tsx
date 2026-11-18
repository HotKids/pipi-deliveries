import {
  Button, Divider, gradient, HStack, Image, Script, Text, TimelineCanvas, VStack, ZStack,
  useEffect, useMemo, useRef, useState,
} from "scripting";
import type { ParcelActivityContent } from "../services/parcel-pickup";

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

function PickupTabArtwork({ logoPath, logoSize }: { logoPath?: string; logoSize: number }) {
  const [appearance, setAppearance] = useState(0);
  const hasAppeared = useRef(false);
  const root = `${Script.directory}/assets/parcel-activity`;
  if (boxAtlas === undefined) boxAtlas = UIImage.fromFile(root + "/box-frames.png");
  const logo = useMemo(() => logoPath ? UIImage.fromFile(logoPath) : null, [logoPath]);
  return (
    <ZStack alignment="topLeading" frame={{ width: ART_WIDTH, height: ART_HEIGHT }}
      onAppear={() => {
        if (hasAppeared.current) setAppearance((visit) => visit + 1);
        hasAppeared.current = true;
      }}>
      {boxAtlas ? <AnimatedBox key={appearance} atlas={boxAtlas} logo={logo} logoSize={logoSize} /> : (
        <ZStack alignment="topLeading">
          <Image filePath={root + "/box.png"} resizable scaleToFit frame={{ width: ART_WIDTH, height: ART_HEIGHT }} />
          {logo ? <Image image={logo} resizable scaleToFit frame={{ width: logoSize, height: logoSize }}
            offset={{ x: 50 - logoSize / 2, y: 64 - logoSize / 2 }} /> : null}
        </ZStack>
      )}
    </ZStack>
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
  onLocationTap?: () => void;
}) {
  const { data } = props;
  const handoff = data.kind === "handoff";
  const logoSize = handoff ? 20 : 26;
  const logoPath = !data.platform ? undefined : handoff
    ? `${Script.directory}/assets/platform-accounts/${data.platform}.png`
    : `${Script.directory}/assets/parcel-activity/${data.platform}.png`;
  const hasLocation = Boolean(props.locationText || data.location);
  const location = props.locationText || data.location || (handoff ? "" : "请及时取件");
  const locationRow = location ? (
    <HStack spacing={4}>
      <Image systemName={handoff ? "calendar" : hasLocation ? "storefront" : "note.text"}
        font={13} foregroundStyle="#B8B3BB" />
      <Text font={13} foregroundStyle="#B8B3BB" lineLimit={1}>
        {location}
      </Text>
    </HStack>
  ) : null;
  const title = (
    <Text font={17} fontWeight="semibold" foregroundStyle={handoff ? "#3275D6" : "white"} lineLimit={1}>
      {props.title}
    </Text>
  );
  const shownCode = data.code.length >= 7 ? data.code.replace(/[^0-9A-Za-z]/g, "") || data.code : data.code;
  const code = (
    <Text
      font={28}
      fontWeight="semibold"
      foregroundStyle="white"
      monospacedDigit
      lineLimit={1}
      minScaleFactor={19 / 28}
    >
      {shownCode}
    </Text>
  );
  return (
    <HStack
      alignment="center"
      spacing={2}
      padding={{ top: 9, bottom: 6, trailing: 12 }}
      frame={{ maxWidth: "infinity", alignment: "leading" }}
      background={gradient("linear", {
        colors: ["#22262D", "#38232D"], startPoint: "leading", endPoint: "trailing",
      })}
      contentShape="rect"
      onTapGesture={props.onDetail}
    >
      <PickupTabArtwork logoPath={logoPath} logoSize={logoSize} />
      <VStack alignment="leading" spacing={6} frame={{ maxWidth: "infinity", alignment: "leading" }}>
        {props.onEditNote ? (
          <Button buttonStyle="plain" action={props.onEditNote}>{title}</Button>
        ) : title}
        {props.onLocationTap && locationRow ? (
          <Button buttonStyle="plain" action={props.onLocationTap}>
            {locationRow}
          </Button>
        ) : locationRow}
        <Divider opacity={0.24} />
        <HStack spacing={8} frame={{ maxWidth: "infinity", alignment: "leading" }}>
          {props.onCopy ? <Button buttonStyle="plain" action={props.onCopy}>{code}</Button> : code}
          {props.onComplete ? (
            <Button buttonStyle="plain" action={props.onComplete} disabled={props.actionPending}
              frame={{ maxWidth: "infinity", alignment: "trailing" }}>
              <HStack spacing={5} padding={{ horizontal: 9 }} frame={{ minHeight: 35 }}
                fixedSize={{ horizontal: true, vertical: false }} background={{ style: "rgba(255,255,255,0.15)", shape: "capsule" }}>
                {handoff || props.actionLabel ? (
                  <Image systemName="shippingbox.fill" font={13} foregroundStyle="white" />
                ) : (
                  <Image filePath={`${Script.directory}/assets/parcel-activity/hand-package.png`}
                    renderingMode="original" resizable scaleToFit frame={{ width: 19, height: 19 }} />
                )}
                <Text font={13} foregroundStyle="white">{props.actionLabel || (handoff ? "我已寄件" : "我已取件")}</Text>
              </HStack>
            </Button>
          ) : null}
        </HStack>
      </VStack>
    </HStack>
  );
}
