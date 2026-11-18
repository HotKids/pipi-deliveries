import {
  AppEvents, Button, Canvas, Form, GeometryReader, HStack, Image, Section,
  Text, VStack, ZStack, useEffect, useMemo, useObservable, useRef, useState,
} from "scripting";
import { bundledImage } from "../components/bundled-image";
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
type ScanState = Readonly<{ display: { code: StationIdentityCode; qr: UIImage | null } | null; remaining: number }>;
const EMPTY_SCAN: ScanState = { display: null, remaining: 0 };
const identityCache = new Map<IdentityPlatform, { generation: string; code: StationIdentityCode }>();
const BARCODE_SHAPE = { type: "rect", cornerRadius: 10 } as const;
const QR_SHAPE = { type: "rect", cornerRadius: 14 } as const;

export function StationIdentityMark({ asset }: { asset: IdentityPlatform | "taobao" }) {
  const size = 28;
  const frame = { width: size, height: size };
  const artwork = bundledImage(`platform-accounts/${asset}.png`);
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
    <Canvas frame={{ width, height, maxWidth: width === undefined ? 330 : undefined }}
      clipShape={BARCODE_SHAPE}
      draw={(ctx, size) => {
        ctx.fillStyle = "white";
        ctx.fillRect(0, 0, size.width, size.height);
        const unit = (vertical ? size.height : size.width) / modules;
        const thickness = (vertical ? size.width : size.height) - 24;
        const scale = Device.screen.scale;
        ctx.fillStyle = "black";
        let offset = 10;
        for (let index = 0; index < widthList.length; index++) {
          const width = widthList[index];
          if (index % 2 === 0) {
            const start = Math.round(offset * unit * scale) / scale;
            const end = Math.round((offset + width) * unit * scale) / scale;
            if (vertical) ctx.fillRect(12, start, thickness, end - start);
            else ctx.fillRect(start, 12, end - start, thickness);
          }
          offset += width;
        }
      }} />
  );
}

function countdown(seconds: number): string {
  const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
  return `${minutes}:${String(seconds % 60).padStart(2, "0")} 后自动刷新`;
}

function FullScreenIdentity({ format, scan, onClose }: {
  format: ScanFormat;
  scan: Observable<ScanState>;
  onClose: () => void;
}) {
  const [{ display, remaining }, setScan] = useState(() => scan.value);
  useEffect(() => {
    scan.subscribe(setScan);
    setScan(scan.value);
    return () => scan.unsubscribe(setScan);
  }, [scan]);
  const code = display?.code.value;
  const widths = useMemo(() => code ? code128Widths(code) : [], [code]);
  const image = display?.qr;
  return (
    <ZStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
      <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity" }} background="white" ignoresSafeArea />
      {code && remaining > 0 ? (
        <VStack spacing={18} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
          padding={{ top: 72, bottom: 32, horizontal: 24 }}>
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
                    : format === "qr" && image && qrSize > 0
                      ? <Image image={image} resizable scaleToFit interpolation="none"
                        frame={{ width: qrSize, height: qrSize }} />
                      : null}
                </VStack>
              );
            }}
          </GeometryReader>
          <VStack spacing={6}>
            <Text font={14} fontWeight="medium" foregroundStyle="#1C1C1E" lineLimit={1}
              minScaleFactor={0.55} monospacedDigit>{code}</Text>
            <Text font={12} foregroundStyle="#636366">
              {format === "barcode" ? "请将条码对准扫码口" : "请将二维码对准扫描区"}
            </Text>
            <Text font={12} monospacedDigit foregroundStyle="#636366">{countdown(remaining)}</Text>
          </VStack>
        </VStack>
      ) : <Text font={15} foregroundStyle="#636366">身份码已过期</Text>}
      <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "topTrailing" }}
        padding={{ top: 16, trailing: 20 }}>
        <Button title="关闭" systemImage="xmark" labelStyle="iconOnly" buttonStyle="plain" action={onClose}
          foregroundStyle="#1C1C1E" frame={{ width: 44, height: 44 }}
          background={{ style: "#F1F1F3", shape: "circle" }} />
      </VStack>
    </ZStack>
  );
}

export function StationIdentityPage({ platform }: { platform: IdentityPlatform }) {
  const [generation, setGeneration] = useState(() => platformSession(platform)?.generation);
  useEffect(() => onPlatformAccountsChanged(() => {
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
  const { display, remaining } = scan.value;
  const [full, setFull] = useState<ScanFormat | null>(null);
  const [busy, setBusy] = useState(Boolean(expectedGeneration));
  const [loggingIn, setLoggingIn] = useState(false);
  const [notice, setNotice] = useState("");
  const [reason, setReason] = useState("");
  const active = useRef(true);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const requestedRenewal = useRef(0);
  const widthList = useMemo(() => display ? code128Widths(display.code.value) : [], [display]);
  const currentSession = () => expectedGeneration ? currentPlatformSession(platform, expectedGeneration) : null;

  function clear() {
    generation.current++;
    scan.setValue(EMPTY_SCAN);
  }

  async function showCode(code: StationIdentityCode, request: number) {
    const current = () => mounted.current && active.current && request === generation.current && !!currentSession();
    const remaining = Math.ceil((code.expiresAtMs - Date.now()) / 1_000);
    if (!current() || remaining <= 0) return;
    scan.setValue({ display: { code, qr: null }, remaining });
    const qr = await QRCode.generate(code.value).catch(() => null);
    const shown = scan.value;
    if (qr && current() && shown.display?.code === code) scan.setValue({ ...shown, display: { code, qr } });
  }

  async function refresh(manual = false) {
    if (busyRef.current || !active.current || !mounted.current) return;
    const session = currentSession();
    if (!session) return;
    const request = generation.current;
    busyRef.current = true;
    setBusy(true);
    setReason("");
    if (manual) setNotice("正在获取身份码…");
    try {
      const code = await fetchStationIdentity(platform, session);
      if (!currentSession()) return;
      if (code.expiresAtMs <= Date.now()) throw new PlatformWireError("unavailable");
      identityCache.set(platform, { generation: session.generation, code });
      void showCode(code, request);
    } catch (error) {
      if (mounted.current && active.current && request === generation.current) {
        const verification = error instanceof PlatformWireError && error.reason === "verification";
        setReason(verification ? "请在网页完成安全验证" : "未获取到身份码，请点右上角重试");
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) {
        setBusy(false);
        if (active.current && request !== generation.current && !scan.value.display) void refresh();
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
    let timer: number | undefined;
    function tick() {
      if (!mounted.current) return;
      timer = setTimeout(tick, 500);
      const current = scan.value;
      if (!active.current || !current.display) return;
      const { code } = current.display;
      const time = Date.now();
      const left = Math.max(0, Math.ceil((code.expiresAtMs - time) / 1_000));
      if (left !== current.remaining) scan.setValue(left ? { display: current.display, remaining: left } : EMPTY_SCAN);
      if (code.expiresAtMs - time <= 1000 && requestedRenewal.current !== code.expiresAtMs) {
        requestedRenewal.current = code.expiresAtMs;
        void refresh();
      }
    }
    tick();
    const cached = identityCache.get(platform);
    if (cached?.generation === expectedGeneration) void showCode(cached.code, generation.current);
    void refresh();
    return () => {
      mounted.current = false;
      if (timer !== undefined) clearTimeout(timer);
      AppEvents.scenePhase.removeListener(onScene);
    };
  }, []);

  const code = remaining > 0 ? display?.code : undefined;
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
            {display && code ? (
              <VStack spacing={12} frame={{ maxWidth: "infinity" }}>
                <Button buttonStyle="plain" action={() => setFull("barcode")}>
                  <VStack padding={{ vertical: 8, horizontal: 12 }}
                    background={{ style: "white", shape: BARCODE_SHAPE }} contentShape="rect">
                    <Barcode widthList={widthList} height={78} />
                  </VStack>
                </Button>
                {display.qr ? (
                  <Button buttonStyle="plain" action={() => setFull("qr")}>
                    <Image image={display.qr} resizable scaleToFit interpolation="none"
                      frame={{ width: 184, height: 184 }} padding={8}
                      background={{ style: "white", shape: QR_SHAPE }} contentShape="rect" />
                  </Button>
                ) : null}
                <Text font={13} foregroundStyle="secondaryLabel">
                  {display.qr ? "点条形码或二维码可全屏出示" : "点条形码可全屏出示"}
                </Text>
                <Text font={12} monospacedDigit foregroundStyle="secondaryLabel">
                  {busy ? "正在刷新…" : countdown(remaining)}
                </Text>
              </VStack>
            ) : <Text foregroundStyle="secondaryLabel" padding={{ vertical: 24 }}>
              {busy ? "正在获取身份码…" : reason || "身份码已过期"}
            </Text>}
          </VStack>
        </Section>
      ) : null}
      {code?.mobile ? (
        <Section header={<Text>取件人</Text>}>
          <HStack>
            <Text>绑定手机号</Text>
            <Text foregroundStyle="secondaryLabel" frame={{ maxWidth: "infinity", alignment: "trailing" }}>{code.mobile}</Text>
          </HStack>
        </Section>
      ) : null}
      {code ? (
        <Section header={<Text>身份码编号</Text>}>
          <HStack spacing={12}>
            <StationIdentityMark asset={platform === "cainiao" ? "taobao" : platform} />
            <Text font={17} fontWeight="bold" lineLimit={1} minScaleFactor={0.55}
              frame={{ maxWidth: "infinity", alignment: "leading" }}>
              {code.value.replace(/(\d{4})(\d{4})(\d{4})/, "$1 $2 $3")}
            </Text>
            <Button title="复制" buttonStyle="bordered" action={() => {
              if (!currentSession() || code.expiresAtMs <= Date.now()) return;
              void copyText(code.value);
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
