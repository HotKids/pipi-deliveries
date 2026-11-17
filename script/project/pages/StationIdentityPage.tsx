import {
  AppEvents, Button, Canvas, GeometryReader, HStack, Image, Navigation, NavigationStack, Script,
  ScrollView, Text, VStack, ZStack, useEffect, useMemo, useObservable, useRef, useState,
} from "scripting";
import { code128Widths } from "../services/code128";
import { currentPlatformSession, onPlatformAccountsChanged, platformSession,
  type IdentityPlatform, type PlatformSession } from "../services/platform-accounts";
import { fetchStationIdentity, identityWebCookies, IDENTITY_WEB_URL, openProviderController, PlatformWireError,
  type StationIdentityCode } from "../services/platform-wire";
import { transientToast } from "../services/ui-feedback";

export const IDENTITY_STATION_NAMES: Record<IdentityPlatform, string> = {
  cainiao: "菜鸟驿站",
  pinduoduo: "多多驿站",
};
const IDENTITY_CODE_TITLES: Record<IdentityPlatform, string> = {
  cainiao: "淘宝身份码",
  pinduoduo: "多多驿站身份码",
};

type ScanFormat = "barcode" | "qr";
type ScanState = Readonly<{ display: { code: StationIdentityCode; qr: UIImage | null } | null; remaining: number }>;
const EMPTY_SCAN: ScanState = { display: null, remaining: 0 };
const BARCODE_SHAPE = { type: "rect", cornerRadius: 10 } as const;
const QR_SHAPE = { type: "rect", cornerRadius: 14 } as const;

export function StationIdentityMark({ platform }: { platform: IdentityPlatform }) {
  const asset = platform === "cainiao" ? "taobao" : platform;
  return <Image
    filePath={`${Script.directory}/assets/platform-accounts/${asset}.png`}
    resizable scaleToFit interpolation="high" frame={{ width: 28, height: 28 }} clipShape="circle"
  />;
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
    <Canvas frame={{ width, height, maxWidth: width === undefined ? "infinity" : undefined }}
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
      <GeometryReader>
        {({ size }) => {
          const availableHeight = Math.max(0, size.height - 104 - 40 - 36);
          const landscape = size.width > size.height;
          const longer = Math.min(Math.max(size.width, size.height) - 330, 640,
            landscape ? size.width - 48 : availableHeight);
          const shorter = Math.min(size.width - 50, 340, landscape ? availableHeight : size.width);
          const qrSize = Math.min(320, size.width - 48, availableHeight);
          return (
            <VStack spacing={18} padding={{ top: 104, bottom: 40, horizontal: 24 }}
              frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
              {display && remaining > 0 ? (
                <VStack spacing={18} frame={{ maxWidth: "infinity", maxHeight: "infinity" }}>
                  {format === "barcode" && longer > 0 && shorter > 24
                    ? <Barcode widthList={widths} vertical={!landscape}
                      width={landscape ? longer : shorter} height={landscape ? shorter : longer} />
                    : format === "qr" && image && qrSize > 0
                      ? <Image image={image} resizable scaleToFit interpolation="none"
                        frame={{ width: qrSize, height: qrSize }} />
                      : null}
                  <Text font={13} monospacedDigit foregroundStyle="#636366">{countdown(remaining)}</Text>
                </VStack>
              ) : <Text font={15} foregroundStyle="#636366">身份码已过期</Text>}
            </VStack>
          );
        }}
      </GeometryReader>
      <VStack frame={{ maxWidth: "infinity", maxHeight: "infinity", alignment: "topTrailing" }}
        padding={{ top: 16, trailing: 20 }}>
        <Button title="关闭" systemImage="xmark" labelStyle="iconOnly" buttonStyle="plain" action={onClose}
          foregroundStyle="#1C1C1E" frame={{ width: 44, height: 44 }}
          background={{ style: "#F1F1F3", shape: "circle" }} />
      </VStack>
    </ZStack>
  );
}

function StationIdentityPage({ platform, session }: { platform: IdentityPlatform; session: PlatformSession }) {
  const dismiss = Navigation.useDismiss();
  const scan = useObservable<ScanState>(EMPTY_SCAN);
  const { display, remaining } = scan.value;
  const [full, setFull] = useState<ScanFormat | null>(null);
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState("");
  const [reason, setReason] = useState("");
  const active = useRef(true);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const generation = useRef(0);
  const requestedRenewal = useRef(0);
  const widthList = useMemo(() => display ? code128Widths(display.code.value) : [], [display]);

  function clear() {
    generation.current++;
    scan.setValue(EMPTY_SCAN);
  }

  async function refresh(manual = false) {
    if (busyRef.current || !active.current || !mounted.current ||
      !currentPlatformSession(platform, session.generation)) return;
    const request = generation.current;
    busyRef.current = true;
    setBusy(true);
    setReason("");
    if (manual) setNotice("正在获取身份码…");
    try {
      const code = await fetchStationIdentity(platform, session);
      const qrImage = await QRCode.generate(code.value).catch(() => null);
      if (!mounted.current || !active.current || request !== generation.current ||
        !currentPlatformSession(platform, session.generation)) return;
      const received = Date.now();
      if (code.expiresAtMs <= received) throw new PlatformWireError("unavailable");
      scan.setValue({ display: { code, qr: qrImage }, remaining: Math.ceil((code.expiresAtMs - received) / 1_000) });
    } catch (error) {
      if (mounted.current && active.current && request === generation.current) {
        const verification = error instanceof PlatformWireError && error.reason === "verification";
        setReason(verification ? "请在网页完成安全验证" : "身份码暂时不可用");
      }
    } finally {
      busyRef.current = false;
      if (mounted.current) {
        setBusy(false);
        if (active.current && request !== generation.current && !scan.value.display) void refresh();
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
    const accountChanged = onPlatformAccountsChanged(() => {
      if (currentPlatformSession(platform, session.generation)) return;
      clear();
      setReason("登录已失效，请重新登录");
    });
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
    void refresh();
    return () => {
      mounted.current = false;
      if (timer !== undefined) clearTimeout(timer);
      accountChanged();
      AppEvents.scenePhase.removeListener(onScene);
    };
  }, []);

  return (
    <NavigationStack>
      <ScrollView frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
        background="systemGroupedBackground"
        presentationDetents={["medium", "large"]}
        presentationDragIndicator="visible"
        navigationBarTitleDisplayMode="inline"
        fullScreenCover={{
          isPresented: full !== null,
          onChanged: (shown) => { if (!shown) setFull(null); },
          content: <FullScreenIdentity format={full ?? "barcode"} scan={scan} onClose={() => setFull(null)} />,
        }}
        toast={transientToast(notice, setNotice)}
        toolbar={{
          topBarLeading: <Button title="关闭" systemImage="xmark" labelStyle="iconOnly" action={() => dismiss()} />,
          principal: (
            <HStack spacing={8}>
              <StationIdentityMark platform={platform} />
              <Text font={17} fontWeight="semibold" lineLimit={1}>{IDENTITY_CODE_TITLES[platform]}</Text>
            </HStack>
          ),
          topBarTrailing: <Button title="刷新身份码" systemImage="arrow.clockwise" labelStyle="iconOnly"
            action={() => void refresh(true)} disabled={busy || !currentPlatformSession(platform, session.generation)} />,
        }}
      >
        <VStack spacing={12} padding={{ vertical: 8, horizontal: 20 }} frame={{ maxWidth: "infinity" }}>
          {display && remaining > 0 ? (
            <VStack spacing={12} padding={{ vertical: 8, horizontal: 12 }} frame={{ maxWidth: 378 }}
              background={{ style: "secondarySystemGroupedBackground", shape: QR_SHAPE }}>
              <Button buttonStyle="plain" action={() => setFull("barcode")}>
                <VStack spacing={4}>
                  <Barcode widthList={widthList} height={94} />
                  <Text font={12} foregroundStyle="secondaryLabel">条形码</Text>
                </VStack>
              </Button>
              {display.qr ? (
                <Button buttonStyle="plain" action={() => setFull("qr")}>
                  <VStack spacing={4}>
                    <Image image={display.qr} resizable scaleToFit interpolation="none"
                      frame={{ width: 184, height: 184 }} padding={8}
                      background={{ style: "white", shape: QR_SHAPE }} />
                    <Text font={12} foregroundStyle="secondaryLabel">二维码</Text>
                  </VStack>
                </Button>
              ) : null}
              <Text font={13} monospacedDigit foregroundStyle="secondaryLabel">{countdown(remaining)}</Text>
            </VStack>
          ) : <Text foregroundStyle="secondaryLabel" padding={{ vertical: 24 }}>
            {busy ? "正在获取身份码…" : reason || "身份码已过期"}
          </Text>}
          <Button title="在网页打开" buttonStyle="plain" action={() => {
            void openWebIdentity(platform, currentPlatformSession(platform, session.generation))
              .catch(() => setNotice("网页打开失败，请重试。"));
          }} />
        </VStack>
      </ScrollView>
    </NavigationStack>
  );
}

export async function presentStationIdentity(platform: IdentityPlatform): Promise<void> {
  const session = platformSession(platform);
  if (!session) return openWebIdentity(platform, null);
  await Navigation.present({ element: <StationIdentityPage platform={platform} session={session} />, modalPresentationStyle: "pageSheet" });
}
