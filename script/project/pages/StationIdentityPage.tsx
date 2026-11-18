import {
  AbortController, AppEvents, Button, Canvas, Form, GeometryReader, HStack, Image, QRImage, Section,
  Text, VStack, ZStack, useEffect, useMemo, useObservable, useRef, useState,
} from "scripting";
import { useBundledImage } from "../components/bundled-image";
import { iconTileShape } from "../components/icon-tile";
import { copyText } from "../services/clipboard";
import { code128Widths } from "../services/code128";
import { currentPlatformSession, onPlatformAccountsChanged, platformSession,
  type IdentityPlatform, type PlatformSession } from "../services/platform-accounts";
import { fetchStationIdentity, identityWebCookies, IDENTITY_WEB_URL, openProviderController, PlatformWireError,
  type StationIdentityCode } from "../services/platform-wire";
import { transientToast } from "../services/ui-feedback";
import { presentPlatformLogin } from "./PlatformAccountPages";

const IDENTITY_CODE_TITLES: Record<IdentityPlatform, string> = {
  cainiao: "淘宝身份码",
  pinduoduo: "多多驿站身份码",
};

type ScanFormat = "barcode" | "qr";
type ScanState = [value: string, expiresAtMs: number, remaining: number, mobile: string];
const EMPTY_SCAN: ScanState = ["", 0, 0, ""];
const identityCache = new Map<IdentityPlatform, { generation: string; code: StationIdentityCode }>();
const BARCODE_SHAPE = { type: "rect", cornerRadius: 10 } as const;
const QR_SHAPE = { type: "rect", cornerRadius: 14 } as const;

export function StationIdentityMark({ asset, size = 28 }: { asset: IdentityPlatform | "taobao"; size?: number }) {
  const frame = { width: size, height: size };
  const artwork = useBundledImage(`platform-accounts/${asset}.png`);
  return artwork ? <Image image={artwork}
    resizable scaleToFit interpolation="high" frame={frame} clipShape={iconTileShape(size)}
  /> : <Image systemName="person.text.rectangle" frame={frame} />;
}

async function openWebIdentity(platform: IdentityPlatform, session: PlatformSession | null) {
  const cookies = identityWebCookies(platform, session);
  const controller = await openProviderController(platform, cookies);
  try {
    if (session && !currentPlatformSession(platform, session.generation)) throw new PlatformWireError("changed");
    const stopListening = onPlatformAccountsChanged(() => {
      if (session && !currentPlatformSession(platform, session.generation)) controller.dismiss();
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

function Barcode({ widthList, width, height, vertical = false }: {
  widthList: readonly number[];
  width?: number;
  height: number;
  vertical?: boolean;
}) {
  const modules = widthList.reduce((sum, width) => sum + width, 20);
  return (
    <Canvas frame={{ width, height, maxWidth: width === undefined ? Math.min(Device.screen.width - 64, 330) : undefined }}
      clipShape={BARCODE_SHAPE}
      draw={(ctx, size) => {
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, size.width, size.height);
        const unit = (vertical ? size.height : size.width) / modules;
        const thickness = vertical ? size.width : size.height;
        const scale = Device.screen.scale;
        ctx.fillStyle = "black";
        let offset = 10;
        for (let index = 0; index < widthList.length; index++) {
          const width = widthList[index];
          if (index % 2 === 0) {
            const start = Math.round(offset * unit * scale) / scale;
            const end = Math.round((offset + width) * unit * scale) / scale;
            if (vertical) ctx.fillRect(0, start, thickness, end - start);
            else ctx.fillRect(start, 0, end - start, thickness);
          }
          offset += width;
        }
      }} />
  );
}

function countdown(seconds: number): string {
  const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
  return seconds > 1 ? `${minutes}:${String(seconds % 60).padStart(2, "0")} 后自动换码` : "正在自动换码…";
}

function FullScreenIdentity({ format, scan, onClose }: {
  format: ScanFormat;
  scan: Observable<ScanState>;
  onClose: () => void;
}) {
  const [[value, , remaining], setScan] = useState(() => scan.value);
  useEffect(() => {
    scan.subscribe(setScan);
    setScan(scan.value);
    return () => scan.unsubscribe(setScan);
  }, [scan]);
  const widths = useMemo(() => value ? code128Widths(value) : [], [value]);
  return (
    <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }} background="white" ignoresSafeArea>
      {value && remaining > 0 ? (
        <VStack spacing={18} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
          padding={{ top: 104, bottom: 40, horizontal: 24 }}>
          <GeometryReader>
            {({ size }) => {
              const { width, height } = Device.screen;
              const landscape = width > height;
              const longer = Math.min(Math.max(width, height) - 330, 640, landscape ? size.width : size.height);
              const shorter = Math.min(Math.min(width, height) - 50, 340, landscape ? size.height : size.width);
              const qrSize = Math.min(320, size.width, size.height);
              return (
                <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
                  {format === "barcode" && longer > 24 && shorter > 24
                    ? <Barcode widthList={widths} vertical={!landscape}
                      width={landscape ? longer : shorter} height={landscape ? shorter : longer} />
                    : format === "qr" && qrSize > 0
                      ? <QRImage data={value} size={qrSize} />
                      : null}
                </VStack>
              );
            }}
          </GeometryReader>
          <VStack spacing={8}>
            <Text font={14} fontWeight="medium" foregroundStyle="#1C1C1E" lineLimit={1}
              minScaleFactor={0.55}>{value}</Text>
            <Text font={12} foregroundStyle="#636366">
              {format === "barcode" ? "条码已横向铺满，直接对准扫码口" : "二维码已放大，请对准扫描区"}
            </Text>
            <Text font={12} monospacedDigit foregroundStyle="#636366">{countdown(remaining)}</Text>
          </VStack>
        </VStack>
      ) : <Text font={15} foregroundStyle="#636366">身份码已过期</Text>}
      <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "topTrailing" }}
        padding={{ top: 56, trailing: 20 }}>
        <Button title="关闭" systemImage="xmark" labelStyle="iconOnly" buttonStyle="plain" action={onClose}
          foregroundStyle="#1C1C1E" frame={{ width: 44, height: 44 }}
          background={{ style: "#F1F1F3", shape: "circle" }} />
      </VStack>
    </ZStack>
  );
}

export function StationIdentityPage({ platform }: { platform: IdentityPlatform }) {
  const [generation, setGeneration] = useState(() => platformSession(platform)?.generation);
  useEffect(() => onPlatformAccountsChanged((changed) => {
    if (changed !== platform) return;
    const next = platformSession(platform)?.generation;
    if (identityCache.get(platform)?.generation !== next) identityCache.delete(platform);
    setGeneration(next);
  }), [platform]);
  return <StationIdentityContent key={generation ?? "signed-out"} platform={platform} expectedGeneration={generation} />;
}

function StationIdentityContent({ platform, expectedGeneration }: {
  platform: IdentityPlatform;
  expectedGeneration?: string;
}) {
  const scan = useObservable<ScanState>(EMPTY_SCAN);
  const [value, expiresAtMs, remaining, mobile] = scan.value;
  const [full, setFull] = useState<ScanFormat | null>(null);
  const [busy, setBusy] = useState(Boolean(expectedGeneration));
  const [loggingIn, setLoggingIn] = useState(false);
  const [notice, setNotice] = useState("");
  const [reason, setReason] = useState("");
  const active = useRef(true);
  const mounted = useRef(true);
  const requestInFlight = useRef<AbortController | undefined>(undefined);
  const countdownTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0);
  const requestedRenewal = useRef(0);
  const widthList = useMemo(() => value ? code128Widths(value) : [], [value]);
  const currentSession = () => expectedGeneration ? currentPlatformSession(platform, expectedGeneration) : null;

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
    setReason("");
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
        setReason(verification ? "请在网页完成安全验证" : "未获取到身份码，请点右上角重试");
      }
    } finally {
      requestInFlight.current = undefined;
      if (mounted.current) {
        setBusy(false);
        if (active.current && request !== generation.current && !scan.value[0]) void refresh();
      }
    }
  }

  async function login() {
    if (loggingIn) return;
    setLoggingIn(true);
    try {
      await presentPlatformLogin(platform);
    } catch {
      if (mounted.current) setNotice("登录未完成，请重试");
    } finally {
      if (mounted.current) setLoggingIn(false);
    }
  }

  useEffect(() => {
    if (!expectedGeneration) return;
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
  return (
    <Form navigationTitle={IDENTITY_CODE_TITLES[platform]} listSectionSpacing={8}
      navigationBarTitleDisplayMode="inline"
      toast={transientToast(notice, setNotice)}
      toolbar={{
        topBarTrailing: expectedGeneration ? (
          <Button title="刷新身份码" systemImage="arrow.triangle.2.circlepath" labelStyle="iconOnly"
            action={() => void refresh(true)} disabled={busy} />
        ) : undefined,
      }}
    >
      {!expectedGeneration ? (
        <Section footer={<Text>{platform === "cainiao" ? "登录淘宝后自动获取身份码。" : "授权拼多多后自动获取取件身份码。"}</Text>}>
          <Button title={platform === "cainiao" ? "登录淘宝" : "授权拼多多"} disabled={loggingIn}
            action={() => void login()} />
        </Section>
      ) : null}
      {expectedGeneration ? (
        <Section>
          <VStack spacing={12} padding={{ vertical: 8 }} frame={{ maxWidth: "infinity" }}
            fullScreenCover={{
              isPresented: full !== null,
              onChanged: (shown) => { if (!shown) setFull(null); },
              content: full ? (
                <FullScreenIdentity format={full} scan={scan} onClose={() => setFull(null)} />
              ) : <VStack />,
            }}>
            {valid ? (
              <VStack spacing={12} frame={{ maxWidth: "infinity" }}>
                <Button buttonStyle="plain" action={() => setFull("barcode")}>
                  <VStack padding={{ vertical: 8, horizontal: 12 }}
                    background={{ style: "white", shape: BARCODE_SHAPE }} contentShape="rect">
                    <Barcode widthList={widthList} height={78} />
                  </VStack>
                </Button>
                <Button buttonStyle="plain" action={() => setFull("qr")}>
                  <VStack padding={10} frame={{ width: 200, height: 200 }}
                    background={{ style: "white", shape: QR_SHAPE }} contentShape="rect">
                    <QRImage data={value} size={184} />
                  </VStack>
                </Button>
                <Text font={13} foregroundStyle="secondaryLabel">点条码或二维码可全屏出示</Text>
                <Text font={12} foregroundStyle={remaining > 60 ? "tertiaryLabel" : "systemRed"}>
                  {busy ? "正在刷新…" : countdown(remaining)}
                </Text>
              </VStack>
            ) : <Text foregroundStyle="secondaryLabel" padding={{ vertical: 24 }}>
              {busy ? "正在获取身份码…" : reason || "身份码已过期"}
            </Text>}
          </VStack>
        </Section>
      ) : null}
      {valid && mobile ? (
        <Section header={<Text>取件人</Text>}>
          <HStack>
            <Text>绑定手机号</Text>
            <Text foregroundStyle="secondaryLabel" frame={{ maxWidth: "infinity", alignment: "trailing" }}>{mobile}</Text>
          </HStack>
        </Section>
      ) : null}
      {valid ? (
        <Section header={<Text font={13} foregroundStyle="secondaryLabel">身份码编号</Text>}>
          <HStack spacing={12} padding={{ vertical: 6 }} frame={{ maxWidth: "infinity" }}>
            <StationIdentityMark asset={platform === "cainiao" ? "taobao" : platform} size={34} />
            <Text font={24} fontWeight="bold" lineLimit={1} minScaleFactor={0.55}
              frame={{ maxWidth: "infinity", alignment: "leading" }}>
              {value.replace(/(\d{4})(\d{4})(\d{4})/, "$1 $2 $3")}
            </Text>
            <Button title="复制" buttonStyle="bordered" action={() => {
              if (!currentSession() || expiresAtMs <= Date.now()) return;
              void copyText(value);
            }} />
          </HStack>
        </Section>
      ) : (
        <Section>
          <Button title="在网页打开" action={() => {
            void openWebIdentity(platform, currentSession()).catch(() => setNotice("网页打开失败，请重试。"));
          }} />
        </Section>
      )}
    </Form>
  );
}
