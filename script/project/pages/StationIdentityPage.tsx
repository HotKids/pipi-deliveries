import {
  AbortController, AppEvents, Button, Canvas, Form, GeometryReader, HStack, Image, QRImage, Rectangle, Section,
  Text, VStack, ZStack, useEffect, useMemo, useObservable, useRef, useState,
} from "scripting";
import { useBundledImage } from "../components/bundled-image";
import { iconTileShape } from "../components/icon-tile";
import { copyText } from "../services/clipboard";
import { code128Widths } from "../services/code128";
import { currentPlatformSession, onPlatformAccountsChanged, platformSession,
  type IdentityPlatform, type PlatformSession } from "../services/platform-accounts";
import { fetchStationIdentity, identityWebCookies, IDENTITY_APP_URL, IDENTITY_WEB_URL, openProviderController, PlatformWireError,
  type StationIdentityCode } from "../services/platform-wire";
import { transientToast } from "../services/ui-feedback";

const IDENTITY_CODE_TITLES: Record<IdentityPlatform, string> = {
  cainiao: "淘宝身份码",
  pinduoduo: "拼多多身份码",
};

type ScanFormat = "barcode" | "qr";
type ScanState = [value: string, expiresAtMs: number, remaining: number, mobile: string];
const EMPTY_SCAN: ScanState = ["", 0, 0, ""];
const identityCache = new Map<IdentityPlatform, { generation: string; code: StationIdentityCode }>();
const BARCODE_SHAPE = { type: "rect", cornerRadius: 10, style: "continuous" } as const;
const QR_SHAPE = { type: "rect", cornerRadius: 14, style: "continuous" } as const;
const DETAIL_ROW_INSETS = { top: 12, bottom: 12, leading: 16, trailing: 16 };
const DETAIL_MARK_SIZE = 36;

const detailTitle = (title: string) => <Text font={13} foregroundStyle="secondaryLabel">{title}</Text>;

export function StationIdentityMark({ asset, size = 28 }: { asset: IdentityPlatform | "taobao"; size?: number }) {
  const frame = { width: size, height: size };
  const artwork = useBundledImage(`platform-accounts/${asset}.png`);
  return artwork ? <Image image={artwork}
    resizable scaleToFit interpolation="high" frame={frame} clipShape={iconTileShape(size)}
  /> : <Image systemName="person.text.rectangle" frame={frame} />;
}

async function openWebIdentity(platform: IdentityPlatform, session: PlatformSession) {
  const cookies = identityWebCookies(platform, session);
  const controller = await openProviderController(platform, cookies);
  try {
    if (!currentPlatformSession(platform, session.generation)) throw new PlatformWireError("changed");
    const stopListening = onPlatformAccountsChanged(() => {
      if (!currentPlatformSession(platform, session.generation)) controller.dismiss();
    });
    try {
      const shown = controller.present({ fullscreen: true, navigationTitle: IDENTITY_CODE_TITLES[platform] });
      void controller.loadURL(IDENTITY_WEB_URL[platform]).catch(() => controller.dismiss());
      await shown;
    } finally {
      stopListening();
    }
  } finally {
    controller.dispose();
  }
}

function Barcode({ widthList, width, height }: {
  widthList: readonly number[];
  width?: number;
  height: number;
}) {
  const modules = widthList.reduce((sum, width) => sum + width, 20);
  return (
    <Canvas frame={{ width, height, maxWidth: width === undefined ? Math.min(Device.screen.width - 64, 330) : undefined }}
      clipShape={BARCODE_SHAPE}
      draw={(ctx, size) => {
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, size.width, size.height);
        const unit = size.width / modules;
        const scale = Device.screen.scale;
        ctx.fillStyle = "black";
        let offset = 10;
        for (let index = 0; index < widthList.length; index++) {
          const width = widthList[index];
          if (index % 2 === 0) {
            const start = Math.round(offset * unit * scale) / scale;
            const end = Math.round((offset + width) * unit * scale) / scale;
            ctx.fillRect(start, 0, end - start, size.height);
          }
          offset += width;
        }
      }} />
  );
}

function countdown(seconds: number): string {
  const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
  return seconds > 1 ? `${minutes}:${String(seconds % 60).padStart(2, "0")} 后自动刷新` : "正在自动刷新…";
}

function FullScreenIdentity({ format, scan, onClose }: {
  format: ScanFormat;
  scan: Observable<ScanState>;
  onClose: () => void;
}) {
  const [[value, , remaining, mobile], setScan] = useState(() => scan.value);
  useEffect(() => {
    scan.subscribe(setScan);
    setScan(scan.value);
    return () => scan.unsubscribe(setScan);
  }, [scan]);
  const widths = useMemo(() => value ? code128Widths(value) : [], [value]);
  const number = <Text font={14} fontWeight="medium" foregroundStyle="#1C1C1E" lineLimit={1}
    minScaleFactor={0.55}>{value}</Text>;
  const shrink = <Text font={12} foregroundStyle="#636366">点击可缩小</Text>;
  const time = <Text font={12} monospacedDigit foregroundStyle="#636366">{countdown(remaining)}</Text>;
  return (
    <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }} preferredColorScheme="light"
      contentShape="rect" onTapGesture={onClose}
      accessibilityActions={[{ name: "缩小身份码", action: onClose }]}>
      <Rectangle fill="white" ignoresSafeArea accessibilityHidden />
      {value && remaining > 0 ? format === "barcode" ? (
        <GeometryReader>
          {({ size }) => {
            const portrait = size.height > size.width;
            const length = Math.min(640, Math.max(size.width, size.height) * 0.79);
            const thickness = Math.min(156, Math.min(size.width, size.height) * 0.42);
            return (
              <VStack spacing={12} frame={{ width: length }} rotationEffect={portrait ? 90 : 0}
                position={{ x: size.width / 2, y: size.height / 2 }}>
                {mobile ? <Text font={16} fontWeight="semibold" foregroundStyle="#1C1C1E">{mobile}</Text> : null}
                <Barcode widthList={widths} width={length} height={thickness} />
                <VStack spacing={4}>{number}{shrink}{time}</VStack>
              </VStack>
            );
          }}
        </GeometryReader>
      ) : (
        <VStack spacing={18} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
          padding={24}>
          <GeometryReader>
            {({ size }) => {
              const qrSize = Math.min(320, size.width, size.height);
              return (
                <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
                  {qrSize > 0 ? <QRImage data={value} size={qrSize} /> : null}
                </VStack>
              );
            }}
          </GeometryReader>
          <VStack spacing={8}>
            {number}{shrink}
            {time}
          </VStack>
        </VStack>
      ) : <Text font={15} foregroundStyle="#636366">身份码已过期</Text>}
    </ZStack>
  );
}

export function StationIdentityPage({ platform, onBindingUnavailable }: {
  platform: IdentityPlatform;
  onBindingUnavailable: () => void;
}) {
  const [generation, setGeneration] = useState(() => platformSession(platform)?.generation);
  const handedOff = useRef(false);
  useEffect(() => {
    function updateBinding() {
      const next = platformSession(platform)?.generation;
      if (identityCache.get(platform)?.generation !== next) identityCache.delete(platform);
      setGeneration(next);
      if (!next && !handedOff.current) {
        handedOff.current = true;
        onBindingUnavailable();
      }
    }
    const unsubscribe = onPlatformAccountsChanged((changed) => {
      if (changed === platform) updateBinding();
    });
    updateBinding();
    return unsubscribe;
  }, [platform]);
  return generation
    ? <StationIdentityContent key={generation} platform={platform} expectedGeneration={generation} />
    : <VStack />;
}

function StationIdentityContent({ platform, expectedGeneration }: {
  platform: IdentityPlatform;
  expectedGeneration: string;
}) {
  const scan = useObservable<ScanState>(EMPTY_SCAN);
  const [value, expiresAtMs, remaining, mobile] = scan.value;
  const [full, setFull] = useState<ScanFormat | null>(null);
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState<"verification" | "unavailable" | null>(null);
  const active = useRef(true);
  const mounted = useRef(true);
  const openingRecovery = useRef(false);
  const requestInFlight = useRef<AbortController | undefined>(undefined);
  const countdownTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0);
  const requestedRenewal = useRef(0);
  const widthList = useMemo(() => value ? code128Widths(value) : [], [value]);
  const currentSession = () => currentPlatformSession(platform, expectedGeneration);
  const providerName = platform === "cainiao" ? "淘宝" : "拼多多";

  async function openRecovery(destination: "app" | "verification") {
    const session = currentSession();
    if (!session || openingRecovery.current) return;
    openingRecovery.current = true;
    try {
      if (destination === "app" && await Safari.openURL(IDENTITY_APP_URL[platform]).catch(() => false)) return;
      if (mounted.current && currentSession()) await openWebIdentity(platform, session);
    } catch {
      if (mounted.current) setNotice("暂时无法打开身份码，请重试");
    } finally {
      openingRecovery.current = false;
    }
  }

  function cancelCountdown() {
    if (countdownTimer.current !== undefined) clearTimeout(countdownTimer.current);
    countdownTimer.current = undefined;
  }

  function clear() {
    generation.current++;
    cancelCountdown();
    scan.setValue(EMPTY_SCAN);
  }

  function tick() {
    countdownTimer.current = undefined;
    const [value, expiresAtMs, remaining, mobile] = scan.value;
    if (!mounted.current || !active.current || !value) return;
    const time = Date.now();
    const left = Math.max(0, Math.ceil((expiresAtMs - time) / 1_000));
    if (left !== remaining) scan.setValue(left ? [value, expiresAtMs, left, mobile] : EMPTY_SCAN);
    if (left) countdownTimer.current = setTimeout(tick, 500);
    if (expiresAtMs - time <= 1_000 && requestedRenewal.current !== expiresAtMs) {
      requestedRenewal.current = expiresAtMs;
      void refresh();
    }
  }

  function showCode(code: StationIdentityCode, request: number) {
    if (!mounted.current || !active.current || request !== generation.current) return;
    const remaining = Math.ceil((code.expiresAtMs - Date.now()) / 1_000);
    if (remaining <= 0) return;
    scan.setValue([code.value, code.expiresAtMs, remaining, code.mobile ?? ""]);
    if (countdownTimer.current === undefined) countdownTimer.current = setTimeout(tick, 500);
  }

  async function refresh(manual = false) {
    if (requestInFlight.current || !active.current || !mounted.current) return;
    const session = currentSession();
    if (!session) return;
    const request = generation.current;
    const controller = new AbortController();
    requestInFlight.current = controller;
    setBusy(true);
    setFailure(null);
    if (manual) setNotice("正在获取身份码…");
    try {
      const code = await fetchStationIdentity(platform, session, controller.signal);
      if (controller.signal.aborted || !currentSession()) return;
      if (code.expiresAtMs <= Date.now()) throw new PlatformWireError("unavailable");
      identityCache.set(platform, { generation: session.generation, code });
      showCode(code, request);
    } catch (error) {
      if (mounted.current && active.current && request === generation.current) {
        const verification = error instanceof PlatformWireError && error.reason === "verification";
        setFailure(verification ? "verification" : "unavailable");
      }
    } finally {
      requestInFlight.current = undefined;
      if (mounted.current) {
        setBusy(false);
        if (active.current && request !== generation.current && !scan.value[0]) void refresh();
      }
    }
  }

  useEffect(() => {
    const onScene = (phase: "active" | "inactive" | "background") => {
      if (phase === "active" && !active.current) {
        active.current = true;
        void refresh();
      } else if (phase !== "active" && active.current) {
        active.current = false;
        clear();
      }
    };
    AppEvents.scenePhase.addListener(onScene);
    const cached = identityCache.get(platform);
    if (cached?.generation === expectedGeneration && currentSession()) showCode(cached.code, generation.current);
    void refresh();
    return () => {
      mounted.current = false;
      cancelCountdown();
      requestInFlight.current?.abort();
      AppEvents.scenePhase.removeListener(onScene);
    };
  }, []);

  const valid = Boolean(value) && remaining > 0;
  const status = busy ? "正在获取身份码…" : failure === "verification" ? "请完成安全验证"
    : failure === "unavailable" ? "未获取到身份码，请点右上角重试" : "身份码已过期";
  return (
    <Form navigationTitle={IDENTITY_CODE_TITLES[platform]} listSectionSpacing={8}
      navigationBarTitleDisplayMode="inline"
      toast={transientToast(notice, setNotice)}
      toolbar={{
        topBarTrailing: (
          <Button title="刷新身份码" systemImage="arrow.triangle.2.circlepath" labelStyle="iconOnly"
            action={() => void refresh(true)} disabled={busy} />
        ),
      }}
    >
      <Section>
        <VStack spacing={12} listRowInsets={DETAIL_ROW_INSETS} frame={{ maxWidth: "infinity" }}
          fullScreenCover={{
            isPresented: full !== null,
            onChanged: (shown) => { if (!shown) setFull(null); },
            content: full ? (
              <FullScreenIdentity format={full} scan={scan} onClose={() => setFull(null)} />
            ) : <VStack />,
          }}>
          {valid ? (
            <VStack spacing={12} frame={{ maxWidth: "infinity" }}>
              <Button buttonStyle="plain" action={() => { setFull("barcode"); void refresh(); }}>
                <VStack padding={{ vertical: 8, horizontal: 12 }}
                  background={{ style: "white", shape: BARCODE_SHAPE }} contentShape="rect">
                  <Barcode widthList={widthList} height={78} />
                </VStack>
              </Button>
              <Button buttonStyle="plain" action={() => { setFull("qr"); void refresh(); }}>
                <VStack padding={10} frame={{ width: 200, height: 200 }}
                  background={{ style: "white", shape: QR_SHAPE }} contentShape="rect">
                  <QRImage data={value} size={184} />
                </VStack>
              </Button>
              <Text font={13} foregroundStyle="secondaryLabel">点击条形码或二维码可放大刷新</Text>
              <Text font={12} foregroundStyle={remaining > 60 ? "tertiaryLabel" : "systemRed"}>
                {busy ? "正在刷新…" : countdown(remaining)}
              </Text>
            </VStack>
          ) : <Text foregroundStyle="secondaryLabel" padding={{ vertical: 24 }}>
            {status}
          </Text>}
        </VStack>
      </Section>
      {valid && mobile ? (
        <Section header={detailTitle("取件人")}>
          <HStack frame={{ minHeight: 28 }} listRowInsets={DETAIL_ROW_INSETS}>
            <Text font={16}>绑定手机号</Text>
            <Text font={16} foregroundStyle="secondaryLabel"
              frame={{ maxWidth: "infinity", alignment: "trailing" }}>{mobile}</Text>
          </HStack>
        </Section>
      ) : null}
      {valid ? (
        <Section header={detailTitle("身份码编号")}>
          <HStack spacing={12} frame={{ maxWidth: "infinity" }} listRowInsets={DETAIL_ROW_INSETS}>
            <StationIdentityMark asset={platform === "cainiao" ? "taobao" : platform} size={DETAIL_MARK_SIZE} />
            <Text font={24} fontWeight="bold" lineLimit={1} minScaleFactor={0.55}
              frame={{ maxWidth: "infinity", alignment: "leading" }}>
              {value.replace(/(\d{4})(\d{4})(\d{4})/, "$1 $2 $3")}
            </Text>
            <Button buttonStyle="plain" action={() => {
              if (!currentSession() || expiresAtMs <= Date.now()) return;
              void copyText(value);
            }}>
              <ZStack frame={{ minWidth: 44, minHeight: 44 }} contentShape="rect">
                <Text font={14} fontWeight="semibold" foregroundStyle="accentColor"
                  frame={{ minHeight: DETAIL_MARK_SIZE }} padding={{ horizontal: 12 }}
                  background={{ style: "tertiarySystemFill", shape: "capsule" }}>复制</Text>
              </ZStack>
            </Button>
          </HStack>
        </Section>
      ) : !busy ? (
        <Section>
          <Button buttonStyle="plain" action={() => void openRecovery("app")}>
            <Text foregroundStyle="accentColor" frame={{ maxWidth: "infinity", alignment: "center" }} contentShape="rect">
              在{providerName}内打开
            </Text>
          </Button>
          {failure === "verification" ? (
            <Button buttonStyle="plain" action={() => void openRecovery("verification")}>
              <Text foregroundStyle="accentColor" frame={{ maxWidth: "infinity", alignment: "center" }} contentShape="rect">
                完成安全验证
              </Text>
            </Button>
          ) : null}
        </Section>
      ) : null}
    </Form>
  );
}
