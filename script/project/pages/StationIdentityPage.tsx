import {
  AbortController, AppEvents, Button, Canvas, Form, GeometryReader, HStack, Image, ProgressView, QRImage, Section,
  Text, VStack, useEffect, useMemo, useObservable, useRef, useState,
} from "scripting";
import { ExpandedQRCode, ScanCodeNumber, ScanCodeShrinkHint, ScanCodeSurface } from "../components/ExpandedScanCode";
import { PICKUP_CARD_SPACING } from "../services/parcel-card-appearance";
import { bundledImage } from "../components/bundled-image";
import { iconTileShape } from "../components/icon-tile";
import { copyText } from "../services/clipboard";
import { EXPRESS_TOAST_COPY, PICKUP_TOAST_COPY } from "../services/express-toast-copy";
import { safeRead } from "../services/safe-read";
import { code128Widths } from "../services/code128";
import { currentPlatformSession, onPlatformAccountsChanged, platformSession,
  type IdentityPlatform, type PlatformSession } from "../services/platform-accounts";
import { CAINIAO_OUTBOUND_APP_URL, CAINIAO_OUTBOUND_WEB_URL, fetchStationIdentity, identityWebCookies,
  IDENTITY_APP_URL, IDENTITY_WEB_URL, openProviderController, PlatformWireError, type StationIdentityCode } from "../services/platform-wire";
import { transientToast } from "../services/ui-feedback";

type IdentityVariant = IdentityPlatform | "cainiao-outbound";
export const IDENTITY_CODE_TITLES: Record<IdentityVariant, string> = {
  cainiao: "淘宝身份码",
  "cainiao-outbound": "菜鸟出库码",
  pinduoduo: "拼多多身份码",
};
const CAINIAO_OUTBOUND_PREFERENCE = "stationIdentityCainiaoOutbound";

type ScanFormat = "barcode" | "qr";
type ScanState = [value: string, expiresAtMs: number, remaining: number, mobile: string];
const EMPTY_SCAN: ScanState = ["", 0, 0, ""];
const identityCache = new Map<IdentityVariant, { generation: string; code: StationIdentityCode }>();
const BARCODE_SHAPE = { type: "rect", cornerRadius: 16, style: "continuous" } as const;
const QR_SHAPE = { type: "rect", cornerRadius: 12, style: "continuous" } as const;
const MAX_BARCODE_VALUE_LENGTH = 80;
const DETAIL_ROW_INSETS = { top: 12, bottom: 12, leading: 16, trailing: 16 };
const SCAN_ROW_INSETS = { ...DETAIL_ROW_INSETS, leading: 8, trailing: 8 };
const DETAIL_ROW_HEIGHT = 44;
const DETAIL_MARK_SIZE = 36;

const detailTitle = (title: string) => <Text font={13} foregroundStyle="secondaryLabel">{title}</Text>;

export function StationIdentityMark({ asset, size = 28 }: { asset: IdentityPlatform | "taobao"; size?: number }) {
  const frame = { width: size, height: size };
  const artwork = bundledImage(`platform-accounts/${asset}.png`);
  return artwork ? <Image image={artwork}
    resizable scaleToFit interpolation="high" frame={frame} clipShape={iconTileShape(size)}
  /> : <Image systemName="person.text.rectangle" frame={frame} />;
}

async function openWebIdentity(platform: IdentityPlatform, session: PlatformSession, variant: IdentityVariant) {
  const cookies = identityWebCookies(platform, session);
  const controller = await openProviderController(platform, cookies);
  try {
    if (!currentPlatformSession(platform, session.generation)) throw new PlatformWireError("changed");
    const stopListening = onPlatformAccountsChanged(() => {
      if (!currentPlatformSession(platform, session.generation)) controller.dismiss();
    });
    try {
      const shown = controller.present({ fullscreen: true, navigationTitle: IDENTITY_CODE_TITLES[variant] });
      const address = variant === "cainiao-outbound" ? CAINIAO_OUTBOUND_WEB_URL : IDENTITY_WEB_URL[platform];
      let failed = false;
      void controller.loadURL(address).catch(() => {
        failed = true;
        controller.dismiss();
      });
      await shown;
      if (failed) throw new PlatformWireError("unavailable");
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
    <Canvas frame={{ width, height, maxWidth: width === undefined ? "infinity" : undefined }}
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

function countdown(seconds: number, renewalFailed = false): string {
  const minutes = String(Math.floor(seconds / 60)).padStart(2, "0");
  const mmss = `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
  if (renewalFailed) return seconds > 0 ? `${mmss} 后过期` : "身份码已过期";
  return seconds > 1 ? `${mmss} 后自动刷新` : "正在自动刷新…";
}

function FullScreenIdentity({ format, scan, renewalFailed, onClose }: {
  format: ScanFormat;
  scan: Observable<ScanState>;
  renewalFailed: boolean;
  onClose: () => void;
}) {
  const [[value, , remaining, mobile], setScan] = useState(() => scan.value);
  useEffect(() => {
    scan.subscribe(setScan);
    setScan(scan.value);
    return () => scan.unsubscribe(setScan);
  }, [scan]);
  const canRenderBarcode = Boolean(value) && value.length <= MAX_BARCODE_VALUE_LENGTH;
  const widths = useMemo(() => (canRenderBarcode ? code128Widths(value) : []), [canRenderBarcode, value]);
  const time = <Text font="caption" monospacedDigit foregroundStyle="secondaryLabel">{countdown(remaining, renewalFailed)}</Text>;
  return (
    <ScanCodeSurface closeLabel="缩小身份码" onClose={onClose} followsSystemAppearance>
      {value && remaining > 0 ? format === "barcode" && widths.length > 0 ? (
        <GeometryReader>
          {({ size }) => {
            const portrait = size.height > size.width;
            const length = Math.min(640, Math.max(size.width, size.height) * 0.79);
            const thickness = Math.min(156, Math.min(size.width, size.height) * 0.42);
            return (
              <VStack spacing={12} frame={{ width: length }} rotationEffect={portrait ? 90 : 0}
                position={{ x: size.width / 2, y: size.height / 2 }}>
                {mobile ? <Text font={16} fontWeight="semibold" monospacedDigit foregroundStyle="label">{mobile}</Text> : null}
                <VStack padding={{ vertical: 12, horizontal: 12 }} background={{ style: "white", shape: BARCODE_SHAPE }}>
                  <Barcode widthList={widths} width={Math.max(120, length - 24)} height={thickness} />
                </VStack>
                <VStack spacing={4}><ScanCodeNumber value={value} /><ScanCodeShrinkHint />{time}</VStack>
              </VStack>
            );
          }}
        </GeometryReader>
      ) : (
        <ExpandedQRCode data={value} number={value} footer={time} />
      ) : <Text font={15} foregroundStyle="secondaryLabel">身份码已过期</Text>}
    </ScanCodeSurface>
  );
}

export function StationIdentityPage({ platform, onBindingUnavailable }: {
  platform: IdentityPlatform;
  onBindingUnavailable: () => void;
}) {
  // Keychain and storage reads here have no caller to catch them (G-MED-20): a failure reads as no binding or the
  // default page.
  const [generation, setGeneration] = useState(() => safeRead(() => platformSession(platform)?.generation, undefined));
  const [outbound, setOutbound] = useState(() =>
    safeRead(() => platform === "cainiao" && Storage.get<boolean>(CAINIAO_OUTBOUND_PREFERENCE) === true, false));
  const handedOff = useRef(false);
  const variant = outbound && platform === "cainiao" ? "cainiao-outbound" : platform;
  useEffect(() => {
    function updateBinding() {
      const next = safeRead(() => platformSession(platform)?.generation, undefined);
      if (identityCache.get(platform)?.generation !== next) identityCache.delete(platform);
      if (platform === "cainiao" && identityCache.get("cainiao-outbound")?.generation !== next) {
        identityCache.delete("cainiao-outbound");
      }
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
    ? <StationIdentityContent key={`${generation}:${variant}`} platform={platform} variant={variant}
        expectedGeneration={generation} onSwitchCainiao={() => {
          safeRead(() => Storage.set(CAINIAO_OUTBOUND_PREFERENCE, !outbound), false);
          setOutbound(!outbound);
        }} />
    : <VStack />;
}

function StationIdentityContent({ platform, variant, expectedGeneration, onSwitchCainiao }: {
  platform: IdentityPlatform;
  variant: IdentityVariant;
  expectedGeneration: string;
  onSwitchCainiao: () => void;
}) {
  const scan = useObservable<ScanState>(EMPTY_SCAN);
  const [value, expiresAtMs, remaining, mobile] = scan.value;
  const [full, setFull] = useState<ScanFormat | null>(null);
  const [loading, setLoading] = useState<"automatic" | "manual" | null>("automatic");
  const busy = loading !== null;
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState<"verification" | "unavailable" | null>(null);
  const [accountChanged, setAccountChanged] = useState(false);
  const [renewalFailed, setRenewalFailed] = useState(false);
  const active = useRef(true);
  const mounted = useRef(true);
  const openingRecovery = useRef(false);
  const requestInFlight = useRef<AbortController | undefined>(undefined);
  const countdownTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const generation = useRef(0);
  const requestedRenewal = useRef(0);
  const canRenderBarcode = Boolean(value) && value.length <= MAX_BARCODE_VALUE_LENGTH;
  const widthList = useMemo(() => (canRenderBarcode ? code128Widths(value) : []), [canRenderBarcode, value]);
  const currentSession = () => safeRead(() => currentPlatformSession(platform, expectedGeneration), null);
  const cainiaoOutbound = variant === "cainiao-outbound";
  const providerName = cainiaoOutbound ? "菜鸟" : platform === "cainiao" ? "淘宝" : "拼多多";

  async function openRecovery(destination: "app" | "verification") {
    const session = currentSession();
    if (!session || openingRecovery.current) return;
    openingRecovery.current = true;
    try {
      const app = cainiaoOutbound ? CAINIAO_OUTBOUND_APP_URL : IDENTITY_APP_URL[platform];
      if (destination === "app" && await Safari.openURL(app).catch(() => false)) return;
      if (mounted.current && currentSession()) {
        setNotice(PICKUP_TOAST_COPY.identityCodeOpening);
        await openWebIdentity(platform, session, variant);
      }
    } catch {
      if (mounted.current && currentSession()) setNotice(PICKUP_TOAST_COPY.identityCodeWebUnavailable);
    } finally {
      openingRecovery.current = false;
    }
  }

  async function copyIdentity() {
    if (!value || !currentSession() || expiresAtMs <= Date.now()) return;
    const result = await copyText(value);
    if (mounted.current && currentSession()) {
      setNotice(result === "copied" ? PICKUP_TOAST_COPY.identityCodeCopied : EXPRESS_TOAST_COPY.copyFailed);
    }
  }

  function cancelCountdown() {
    if (countdownTimer.current !== undefined) clearTimeout(countdownTimer.current);
    countdownTimer.current = undefined;
  }

  function clear() {
    generation.current++;
    requestedRenewal.current = 0;
    cancelCountdown();
    setRenewalFailed(false);
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
    if (expiresAtMs - time <= 1_500 && requestedRenewal.current !== expiresAtMs) {
      requestedRenewal.current = expiresAtMs;
      void refresh();
    } else if (left === 0 && !requestInFlight.current) {
      requestedRenewal.current = 0;
      void refresh();
    }
  }

  function showCode(code: StationIdentityCode, request: number) {
    if (!mounted.current || !active.current || request !== generation.current) return;
    const remaining = Math.ceil((code.expiresAtMs - Date.now()) / 1_000);
    if (remaining <= 0) return;
    setRenewalFailed(false);
    scan.setValue([code.value, code.expiresAtMs, remaining, code.mobile ?? ""]);
    if (countdownTimer.current === undefined) countdownTimer.current = setTimeout(tick, 500);
  }

  async function refresh(manual = false) {
    if (requestInFlight.current || !active.current || !mounted.current) return;
    const session = currentSession();
    if (!session) {
      clear();
      setAccountChanged(true);
      return;
    }
    const request = generation.current;
    const controller = new AbortController();
    requestInFlight.current = controller;
    setLoading(manual ? "manual" : "automatic");
    setFailure(null);
    setAccountChanged(false);
    if (manual) setNotice(PICKUP_TOAST_COPY.identityCodeLoading);
    try {
      const code = await fetchStationIdentity(platform, session, controller.signal, cainiaoOutbound);
      if (controller.signal.aborted || !currentSession()) return;
      if (code.expiresAtMs <= Date.now()) throw new PlatformWireError("unavailable");
      identityCache.set(variant, { generation: session.generation, code });
      showCode(code, request);
    } catch (error) {
      if (mounted.current && active.current && request === generation.current) {
        if (!currentSession()) {
          clear();
          setAccountChanged(true);
        } else {
          const reason = error instanceof PlatformWireError ? error.reason : "unavailable";
          setFailure(reason === "verification" ? reason : "unavailable");
          if (scan.value[0] && scan.value[1] > Date.now()) setRenewalFailed(true);
        }
      }
    } finally {
      requestInFlight.current = undefined;
      if (mounted.current) {
        setLoading(null);
        if (active.current && request !== generation.current && !scan.value[0] && currentSession()) void refresh();
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
    const unsubscribeAccount = onPlatformAccountsChanged((changed) => {
      if (changed !== platform || currentSession()) return;
      requestInFlight.current?.abort();
      clear();
      setFull(null);
      setFailure(null);
      setAccountChanged(true);
    });
    AppEvents.scenePhase.addListener(onScene);
    const cached = identityCache.get(variant);
    if (cached?.generation === expectedGeneration && currentSession()) showCode(cached.code, generation.current);
    void refresh();
    return () => {
      mounted.current = false;
      cancelCountdown();
      requestInFlight.current?.abort();
      unsubscribeAccount();
      AppEvents.scenePhase.removeListener(onScene);
    };
  }, []);

  const valid = Boolean(value) && remaining > 0;
  const showNumber = valid || (platform === "cainiao" && !busy && failure !== null);
  const showRecovery = !valid && !busy && !accountChanged;
  // Never fade out an expired barcode or its number during an identity change.
  const revealResult = Transition.asymmetric(Transition.opacity(), Transition.identity());
  const status = busy ? "正在获取身份码…" : accountChanged
    ? "账号已变更或登录已失效，请重新打开身份码"
    : failure === "verification" ? "请完成安全验证"
    : failure === "unavailable" ? "未获取到身份码，请点右上角重试" : "身份码已过期";
  const manualProgress = loading === "manual"
    ? <ProgressView progressViewStyle="circular" accessibilityLabel="正在获取身份码" /> : null;
  const markAsset = platform === "cainiao" && !cainiaoOutbound ? "taobao" : platform;
  const switchTarget = IDENTITY_CODE_TITLES[cainiaoOutbound ? "cainiao" : "cainiao-outbound"];
  const switchLabel = { accessibilityLabel: `切换到${switchTarget}` };
  return (
    <Form navigationTitle={IDENTITY_CODE_TITLES[variant]} listSectionSpacing={PICKUP_CARD_SPACING}
      navigationBarTitleDisplayMode="inline"
      animation={{ animation: Animation.easeOut(0.18), value: `${valid}:${showNumber}:${showRecovery}` }}
      toast={transientToast(notice, setNotice)}
      toolbar={{
        topBarTrailing: (
          <Button title="刷新身份码" systemImage="arrow.triangle.2.circlepath" labelStyle="iconOnly"
            action={() => void refresh(true)} disabled={busy} />
        ),
      }}
    >
      <Section key="identity-scan">
        <VStack spacing={12} listRowInsets={valid ? SCAN_ROW_INSETS : DETAIL_ROW_INSETS} frame={{ maxWidth: "infinity" }}
          fullScreenCover={{
            isPresented: full !== null,
            onChanged: (shown) => { if (!shown) setFull(null); },
            content: full ? (
              <FullScreenIdentity format={full} scan={scan} renewalFailed={renewalFailed} onClose={() => setFull(null)} />
            ) : <VStack />,
          }}>
          {valid ? (
            <VStack spacing={12} frame={{ maxWidth: "infinity" }} transition={revealResult}>
              {widthList.length > 0 ? (
                <Button buttonStyle="plain" action={() => { setFull("barcode"); void refresh(); }}>
                  <VStack padding={{ vertical: 8, horizontal: 4 }} frame={{ maxWidth: "infinity" }}
                    background={{ style: "white", shape: BARCODE_SHAPE }} contentShape="rect">
                    <Barcode widthList={widthList} height={78} />
                  </VStack>
                </Button>
              ) : null}
              <Button buttonStyle="plain" action={() => { setFull("qr"); void refresh(); }}>
                <VStack padding={12} frame={{ width: 200, height: 200 }}
                  background={{ style: "white", shape: QR_SHAPE }} contentShape="rect">
                  <QRImage data={value} size={176} />
                </VStack>
              </Button>
              {widthList.length > 0 ? (
                <Text font={13} foregroundStyle="secondaryLabel">点击条形码或二维码可放大刷新</Text>
              ) : (
                <Text font={13} foregroundStyle="secondaryLabel">点击二维码可放大刷新</Text>
              )}
              {manualProgress ?? <Text font={12} monospacedDigit foregroundStyle={remaining > 60 && !renewalFailed ? "tertiaryLabel" : "systemRed"}>
                {busy ? "正在刷新…" : countdown(remaining, renewalFailed)}
              </Text>}
            </VStack>
          ) : manualProgress ? (
            <VStack frame={{ maxWidth: "infinity", minHeight: DETAIL_ROW_HEIGHT }}>{manualProgress}</VStack>
          ) : <Text font={16} foregroundStyle="secondaryLabel" multilineTextAlignment="center"
            frame={{ maxWidth: "infinity", minHeight: DETAIL_ROW_HEIGHT }}>
            {status}
          </Text>}
        </VStack>
      </Section>
      {valid && mobile ? (
        <Section key="identity-recipient" transition={revealResult} header={detailTitle("取件人")}>
          <HStack frame={{ minHeight: DETAIL_ROW_HEIGHT }} listRowInsets={DETAIL_ROW_INSETS}>
            <Text font={16}>绑定手机号</Text>
            <Text font={16} monospacedDigit foregroundStyle="secondaryLabel"
              frame={{ maxWidth: "infinity", alignment: "trailing" }}>{mobile}</Text>
          </HStack>
        </Section>
      ) : null}
      {showNumber ? (
        <Section key="identity-number" transition={revealResult}
          header={detailTitle(platform === "cainiao" ? `身份码编号（点击图标切换至${switchTarget}）` : "身份码编号")}>
          <HStack spacing={0} frame={{ maxWidth: "infinity", minHeight: DETAIL_ROW_HEIGHT }} listRowInsets={DETAIL_ROW_INSETS}>
            {platform === "cainiao" ? (
              <Button buttonStyle="plain" action={onSwitchCainiao} {...switchLabel}>
                <HStack frame={{ width: 48, minHeight: DETAIL_ROW_HEIGHT, alignment: "leading" }} contentShape="rect">
                  <StationIdentityMark asset={markAsset} size={DETAIL_MARK_SIZE} />
                </HStack>
              </Button>
            ) : <HStack frame={{ width: 48, alignment: "leading" }}>
              <StationIdentityMark asset={markAsset} size={DETAIL_MARK_SIZE} />
            </HStack>}
            <Text font={valid ? 24 : 16} fontWeight={valid ? "bold" : undefined} monospacedDigit
              foregroundStyle={valid ? "label" : "secondaryLabel"} lineLimit={1} minScaleFactor={0.55}
              frame={{ maxWidth: "infinity", alignment: valid ? "leading" : "trailing" }}>
              {valid ? value.replace(/(\d{4})(\d{4})(\d{4})/, "$1 $2 $3") : "暂无编号"}
            </Text>
            {valid ? <Button
              title="复制"
              buttonStyle="bordered"
              buttonBorderShape="capsule"
              padding={{ leading: 12 }}
              action={() => void copyIdentity()}
            /> : null}
          </HStack>
        </Section>
      ) : null}
      {showRecovery ? (
        <Section key="identity-recovery" transition={revealResult}>
          <Button buttonStyle="plain" listRowInsets={DETAIL_ROW_INSETS} action={() => void openRecovery("app")}>
            <Text font={16} foregroundStyle="accentColor"
              frame={{ maxWidth: "infinity", minHeight: DETAIL_ROW_HEIGHT }} contentShape="rect">
              在{providerName}内打开
            </Text>
          </Button>
          {failure === "verification" ? (
            <Button buttonStyle="plain" listRowInsets={DETAIL_ROW_INSETS} action={() => void openRecovery("verification")}>
              <Text font={16} foregroundStyle="accentColor"
                frame={{ maxWidth: "infinity", minHeight: DETAIL_ROW_HEIGHT }} contentShape="rect">
                完成安全验证
              </Text>
            </Button>
          ) : null}
        </Section>
      ) : null}
    </Form>
  );
}
