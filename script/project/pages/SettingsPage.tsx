import { RecognitionSettingsPage } from "./RecognitionSettingsPage";
import { recognitionSettings } from "../services/recognition/settings";
import {
  AppEvents,
  Button,
  HStack,
  Image,
  Link,
  Navigation,
  NavigationStack,
  Section,
  SecureField,
  Spacer,
  Text,
  VStack,
  useEffect,
  useRef,
  useState,
} from "scripting";
import { RootTabList } from "../components/RootPageHeader";
import { ROOT_PAGE_BG } from "../components/TabFloatingActionButton";
import { SETTINGS_ORANGE, SettingsRowIcon } from "../components/SettingsRowIcon";
import type { AppState } from "../models";
import { sendAccountCode } from "../services/account-sync";
import { SCRIPT_VERSION } from "../services/build-track";
import { checkSavedAccessKey } from "../services/carrier-authority";
import {
  gatewayAccessKeyState,
  removeGatewayToken,
  saveGatewayToken,
  subscribeGatewayAccessKeyVerification,
} from "../services/credentials";
import type { GatewayAccessKeyVerification, GatewayCredentialStatus } from "../services/credentials";
import {
  ACCESS_KEY_ACTIVATED_ELSEWHERE_MESSAGE,
  ACCESS_KEY_INVALID_MESSAGE,
} from "../services/gateway";
import { onScriptingActivationRejectionChanged, savedKeyActivatedElsewhere } from "../services/scripting-activation";
import { loadState } from "../services/storage";
import { enhancementOperation, requireEnhancementBinding } from "../services/enhanced-account";
import {
  bindPhone,
  refreshAllShipments,
  unbindPhone,
} from "../services/sync";
import {
  diagnosticErrorDetails,
  diagnosticState,
  writeDiagnostic,
} from "../services/logger";
import { SCRIPT_BINDING_SOURCE } from "../services/script-source";
import { DiagnosticLogPage } from "./DiagnosticLogPage";
import { PhoneManagerPage } from "./PhoneManagerPage";
import { PrivacyPage } from "./PrivacyPage";
import { NotificationSettingsPage } from "./NotificationSettingsPage";
import { ParcelActivityPage, ParcelShortcutPage } from "./PickupSettingsPages";
import { notificationEnabledCount } from "../services/notification-preferences";
import { reconcileFengchaoReminders } from "../services/fengchao-reminders";
import { SAVE_FAILED_TOAST, transientToast } from "../services/ui-feedback";
import { safeRead } from "../services/safe-read";
import { platformRefreshMessage, refreshPlatformParcels } from "../services/platform-parcel-sync";
import { accountStatus, onPlatformAccountsChanged, PLATFORM_SOURCES, type ExpressPlatform } from "../services/platform-accounts";

const PROJECT_URL = "https://github.com/HotKids/pipi-deliveries";
const SETTINGS_BLUE = "#2F7BF6";
const SETTINGS_GRAY = "#8E8E93";

type AuthorizationState = "unauthorized" | "saved" | "authorized" | "rejected" | "unavailable";

function authorizationState(
  credentialStatus: GatewayCredentialStatus,
  verification: GatewayAccessKeyVerification,
): AuthorizationState {
  if (credentialStatus === "configured") {
    if (verification === "accepted") return "authorized";
    if (verification === "rejected") return "rejected";
    return "saved";
  }
  if (
    credentialStatus === "unavailable" ||
    credentialStatus === "conflict"
  ) {
    return "unavailable";
  }
  return "unauthorized";
}

function authorizationPrompt(state: AuthorizationState): string {
  if (state === "authorized" || state === "saved") return "Access Key 已保存";
  if (state === "rejected") return "Access Key 已失效";
  return "请输入 Access Key";
}

function authorizationLabel(state: AuthorizationState): string {
  if (state === "authorized") return "已授权";
  if (state === "saved") return "待验证";
  if (state === "rejected") return "已失效";
  if (state === "unavailable") return "不可用";
  return "未授权";
}

function SettingsAccessoryIcon(props: { systemName: string }) {
  return (
    <Image
      systemName={props.systemName}
      font={13}
      symbolRenderingMode="monochrome"
      foregroundStyle="tertiaryLabel"
      frame={{ width: 14, height: 22 }}
    />
  );
}

function SettingsAppIcon() {
  return <SettingsRowIcon systemName="cat" backgroundColor="#B872AB" />;
}

const OVERVIEW_SECTIONS = ["authorization", "platforms", "notifications"] as const;
type OverviewSection = typeof OVERVIEW_SECTIONS[number];

function useSettingsOverview() {
  const [authorization, setAuthorization] =
    useState<AuthorizationState | undefined>();
  const [authorizationNotice, setAuthorizationNotice] = useState("");
  const [platformCount, setPlatformCount] = useState(0);
  const [enabledNotificationCount, setEnabledNotificationCount] = useState<number | undefined>();
  const visible = useRef(false);
  const checkAuthorization = useRef(false);
  const pending = useRef(new Set<OverviewSection>(OVERVIEW_SECTIONS));
  const pendingPlatforms = useRef(new Set<ExpressPlatform>(PLATFORM_SOURCES));
  const activePlatforms = useRef(new Set<ExpressPlatform>());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  function scheduleOverview(sections: readonly OverviewSection[] = []) {
    for (const section of sections) pending.current.add(section);
    if (!visible.current || timer.current !== undefined || !pending.current.size) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      if (!visible.current) return;
      if (pending.current.delete("authorization")) {
        refreshAuthorization();
        if (checkAuthorization.current) {
          checkAuthorization.current = false;
          void checkSavedAccessKey().catch(error => {
            writeDiagnostic("settings.authorization.check_failed", diagnosticErrorDetails(error), "warning");
          });
        }
      } else if (pending.current.has("platforms")) {
        const platform = pendingPlatforms.current.values().next().value;
        if (platform) {
          pendingPlatforms.current.delete(platform);
          activePlatforms.current.delete(platform);
          try {
            if (accountStatus(platform).state === "active") activePlatforms.current.add(platform);
          } catch {
            writeDiagnostic("settings.platform_count.unavailable", { sourceProvider: platform }, "warning");
          }
        }
        if (!pendingPlatforms.current.size) {
          pending.current.delete("platforms");
          setPlatformCount(activePlatforms.current.size);
        }
      } else if (pending.current.delete("notifications")) {
        setEnabledNotificationCount(notificationEnabledCount(true));
      }
      scheduleOverview();
    }, 0);
  }

  function setOverviewVisible(shown: boolean) {
    visible.current = shown;
    if (shown) {
      checkAuthorization.current = true;
      scheduleOverview(["authorization"]);
    } else if (timer.current !== undefined) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
  }

  useEffect(() => {
    const onScene = (phase: "active" | "inactive" | "background") => {
      if (phase === "active") {
        checkAuthorization.current = true;
        for (const platform of PLATFORM_SOURCES) pendingPlatforms.current.add(platform);
        scheduleOverview(OVERVIEW_SECTIONS);
      }
    };
    AppEvents.scenePhase.addListener(onScene);
    const unsubscribe = onPlatformAccountsChanged(platform => {
      pendingPlatforms.current.add(platform);
      scheduleOverview(["platforms"]);
    });
    const stopActivationObservation = onScriptingActivationRejectionChanged(() => scheduleOverview(["authorization"]));
    const stopKeyVerification = subscribeGatewayAccessKeyVerification(() => scheduleOverview(["authorization"]));
    return () => {
      setOverviewVisible(false);
      AppEvents.scenePhase.removeListener(onScene);
      unsubscribe();
      stopActivationObservation();
      stopKeyVerification();
    };
  }, []);

  function refreshAuthorization(): AuthorizationState {
    try {
      const { status: credentialStatus, verification } = gatewayAccessKeyState();
      const next = authorizationState(credentialStatus, verification);
      setAuthorization(next);
      setAuthorizationNotice(
        credentialStatus === "conflict"
          ? "检测到本地授权记录不一致，请重新保存 Access Key"
          : (next === "saved" || next === "authorized") && savedKeyActivatedElsewhere()
            ? ACCESS_KEY_ACTIVATED_ELSEWHERE_MESSAGE
            : "",
      );
      return next;
    } catch {
      setAuthorization("unavailable");
      setAuthorizationNotice("暂时无法读取访问授权，请稍后重试");
      return "unavailable";
    }
  }

  return { authorization, authorizationNotice, setAuthorizationNotice, platformCount,
    enabledNotificationCount, setEnabledNotificationCount, refreshAuthorization, setOverviewVisible };
}

export function SettingsPage(props: {
  onAccessKeyChanged?: () => void;
  onCloudRecordsRefresh?: () => Promise<void>;
  /** Each increase returns the tab to its root, where the Access Key field is (a Home Access Key notice). */
  rootRequest?: number;
  state: AppState;
  onStateChange: (state: AppState) => void;
}) {
  const dismiss = Navigation.useDismiss();
  const [token, setToken] = useState("");
  const [notice, setNotice] = useState("");
  const [destination, setDestination] =
    useState<"" | "phones" | "notifications" | "diagnostics" | "privacy" | "shortcuts" | "activity" | "recognition">("");
  const [managerNotice, setManagerNotice] = useState("");
  const [recognitionMode, setRecognitionMode] = useState(() =>
    safeRead(() => recognitionSettings().draft.mode, "local" as const));
  useEffect(() => {
    if (!destination) {
      setRecognitionMode(safeRead(() => recognitionSettings().draft.mode, "local" as const));
    }
  }, [destination]);
  const [diagnosticCount, setDiagnosticCount] = useState(0);
  const { authorization, authorizationNotice, setAuthorizationNotice, platformCount, enabledNotificationCount,
    setEnabledNotificationCount, refreshAuthorization, setOverviewVisible } = useSettingsOverview();
  const configured = authorization === "authorized" || authorization === "saved" || authorization === "rejected";

  useEffect(() => {
    if (props.rootRequest) setDestination("");
  }, [props.rootRequest]);

  function saveToken() {
    try {
      saveGatewayToken(token);
      props.onAccessKeyChanged?.();
      setToken("");
      refreshAuthorization();
      setNotice("Access Key 已保存");
    } catch (error) {
      refreshAuthorization();
      const value = error instanceof Error
        ? error.message
        : "保存失败，请稍后重试";
      if (value === ACCESS_KEY_INVALID_MESSAGE) {
        setAuthorizationNotice(value);
      } else {
        setNotice(SAVE_FAILED_TOAST);
      }
    }
  }

  async function removeToken() {
    try {
      const confirmed = await Dialog.confirm({
        title: "移除 Access Key",
        message:
          "移除 Access Key 后将无法同步或查询快递。重新保存 Access Key 即可恢复。",
        cancelLabel: "取消",
        confirmLabel: "移除",
      });
      if (!confirmed) return;
      removeGatewayToken();
      props.onAccessKeyChanged?.();
      setToken("");
      const nextAuthorization = refreshAuthorization();
      setNotice(
        nextAuthorization === "unauthorized"
          ? "Access Key 已移除"
          : "Access Key 移除失败，请稍后重试",
      );
    } catch {
      refreshAuthorization();
      setNotice("Access Key 移除失败，请稍后重试");
    }
  }

  async function manageConfiguredToken() {
    try {
      const index = await Dialog.actionSheet({
        title: "授权管理",
        message: `${authorizationPrompt(authorization ?? "saved")}。粘贴新的 Access Key 可更新授权。`,
        actions: [{ label: "移除 Access Key", destructive: true }],
      });
      if (index === 0) await removeToken();
    } catch {
      setNotice("操作失败，请稍后重试");
    }
  }

  function openPhoneManager() {
    setManagerNotice("");
    setDestination("phones");
  }

  async function bindCurrentPhone(
    phone: string,
    code: string,
    flowId: string,
    enhanced = false,
  ) {
    const requestedSource = SCRIPT_BINDING_SOURCE;
    const handlerSource = SCRIPT_BINDING_SOURCE;
    // D4: the handler writes no start line; the verification (binding.verify.*) and the commit (binding.persisted)
    // end this flow.
    const next = await bindPhone(requestedSource, phone, code, flowId, enhanced);
    props.onStateChange(next);
    void refreshAllShipments(requestedSource, { accountListOnly: true })
      .then((summary) => {
        props.onStateChange(summary.state);
        writeDiagnostic("binding.refresh.succeeded", {
          flowId,
          requestedSource,
          handlerSource,
          ...diagnosticState(summary.state),
          attempted: summary.attempted,
          succeeded: summary.succeeded,
          failed: summary.failed,
        });
      })
      .catch((error) => {
        writeDiagnostic(
          "binding.refresh.failed",
          {
            flowId,
            requestedSource,
            handlerSource,
            // An error handler cannot throw while it logs (G-MED-20).
            ...safeRead(() => diagnosticState(loadState()), {}),
            ...diagnosticErrorDetails(error),
          },
          "warning",
        );
      });
  }

  const boundPhoneCount = props.state.bindings.filter(
    (binding) => binding.source === SCRIPT_BINDING_SOURCE,
  ).length;
  const boundAccountCount = boundPhoneCount + platformCount;

  return (
    <NavigationStack toolbarBackgroundVisibility={{ visibility: "hidden", bars: ["navigationBar"] }}>
      <VStack spacing={0}
        frame={{ maxWidth: "infinity", maxHeight: "infinity" }}
        background={ROOT_PAGE_BG}
        toolbarBackground={{ style: ROOT_PAGE_BG, bars: ["tabBar"] }}
        onAppear={() => setOverviewVisible(true)}
        onDisappear={() => setOverviewVisible(false)}
        toast={transientToast(notice, setNotice)}
        navigationDestination={{
          isPresented: Boolean(destination),
          onChanged: (presented) => {
            if (presented) return;
            setDestination("");
          },
          content: destination === "phones" ? (
            <PhoneManagerPage
              bindings={props.state.bindings}
              stateRevision={props.state.revision}
              busy={false}
              notice={managerNotice}
              pendingEnhancementUnsubscribeCount={props.state.pendingEnhancementUnsubscribes?.length || 0}
              unresolvedEnhancementUnsubscribeCount={props.state.pendingEnhancementUnsubscribes?.filter(
                item => !item.identityFingerprint).length || 0}
              onSendCode={(phone, _flowId, enhanced) => {
                if (enhanced) {
                  requireEnhancementBinding(loadState().bindings, phone);
                  return enhancementOperation("code", phone);
                }
                return sendAccountCode(SCRIPT_BINDING_SOURCE, phone);
              }}
              onBind={bindCurrentPhone}
              onPlatformRefresh={async (platform, onProgress) => platformRefreshMessage(
                await refreshPlatformParcels(props.onStateChange, "manual", platform, onProgress),
              )}
              onCloudRecordsRefresh={props.onCloudRecordsRefresh}
              onRemove={async (binding, localOnly) => {
                setManagerNotice("");
                props.onStateChange(await unbindPhone(binding.source, binding.phone, { localOnly, expectedBinding: binding }));
              }}
              onRefresh={async () => {
                setManagerNotice("");
                const summary = await refreshAllShipments(undefined, {
                  forceManualRefresh: true,
                });
                props.onStateChange(summary.state);
                // The manager reports the outcome through refreshSummaryToast, exactly as
                // HomePage does, so the counts must reach it instead of being dropped here.
                return summary;
              }}
            />
          ) : destination === "privacy" ? (
            <PrivacyPage />
          ) : destination === "notifications" ? (
            <NotificationSettingsPage
              onChanged={(count) => {
                setEnabledNotificationCount(count);
                void reconcileFengchaoReminders(props.state, { preferencesChanged: true });
              }}
            />
          ) : destination === "shortcuts" ? (
            <ParcelShortcutPage />
          ) : destination === "activity" ? (
            <ParcelActivityPage />
          ) : destination === "recognition" ? (
            <RecognitionSettingsPage onSaved={(message) => {
              // A successful save returns here and reports on this page (owner 2026-11-21).
              setRecognitionMode(safeRead(() => recognitionSettings().draft.mode, "local" as const));
              setDestination("");
              setNotice(message);
            }} />
          ) : destination === "diagnostics" ? (
            <DiagnosticLogPage onCountChange={setDiagnosticCount} />
          ) : (
            <Text>设置</Text>
          ),
        }}
      >
        <RootTabList title="设置" onClose={() => dismiss()}>
          <Section header={<Text>同步</Text>}>
            <Button buttonStyle="plain" action={openPhoneManager}>
              <HStack
                spacing={12}
                padding={{ vertical: 5 }}
                frame={{ minHeight: 44, maxWidth: "infinity" }}
                contentShape="rect"
              >
                <SettingsRowIcon systemName="phone" backgroundColor={SETTINGS_ORANGE} />
                <Text>管理账号</Text>
                <Spacer />
                <Text foregroundStyle="secondaryLabel" monospacedDigit>
                  {boundAccountCount ? `已绑定 ${boundAccountCount}` : "未绑定"}
                </Text>
                <SettingsAccessoryIcon systemName="chevron.right" />
              </HStack>
            </Button>
          </Section>

          <Section header={<Text>通知</Text>}>
            <Button
              buttonStyle="plain"
              action={() => setDestination("notifications")}
            >
              <HStack
                spacing={12}
                padding={{ vertical: 5 }}
                frame={{ minHeight: 44, maxWidth: "infinity" }}
                contentShape="rect"
              >
                <SettingsRowIcon systemName="bell" backgroundColor={SETTINGS_BLUE} />
                <Text>通知管理</Text>
                <Spacer />
                <Text foregroundStyle="secondaryLabel" monospacedDigit>
                  {enabledNotificationCount === undefined ? "" : enabledNotificationCount
                    ? `已开启 ${enabledNotificationCount}`
                    : "已关闭"}
                </Text>
                <SettingsAccessoryIcon systemName="chevron.right" />
              </HStack>
            </Button>
          </Section>

          <Section header={<Text>更多</Text>}>
            <Button buttonStyle="plain" action={() => setDestination("recognition")}>
              <HStack spacing={12} padding={{ vertical: 5 }} frame={{ minHeight: 44, maxWidth: "infinity" }} contentShape="rect">
                <SettingsRowIcon systemName="sparkles" backgroundColor={SETTINGS_BLUE} />
                <Text>智能识别</Text>
                <Spacer />
                <Text foregroundStyle="secondaryLabel">
                  {recognitionMode === "online" ? "在线识别" : "本地识别"}
                </Text>
                <SettingsAccessoryIcon systemName="chevron.right" />
              </HStack>
            </Button>
            <Button buttonStyle="plain" action={() => setDestination("shortcuts")}>
              <HStack
                spacing={12}
                padding={{ vertical: 5 }}
                frame={{ minHeight: 44, maxWidth: "infinity" }}
                contentShape="rect"
              >
                <SettingsRowIcon systemName="square.on.square" backgroundColor={SETTINGS_ORANGE} />
                <Text>快捷指令</Text>
                <Spacer />
                <SettingsAccessoryIcon systemName="chevron.right" />
              </HStack>
            </Button>
            <Button buttonStyle="plain" action={() => setDestination("activity")}>
              <HStack
                spacing={12}
                padding={{ vertical: 5 }}
                frame={{ minHeight: 44, maxWidth: "infinity" }}
                contentShape="rect"
              >
                <SettingsRowIcon systemName="rectangle.inset.filled.badge.record" backgroundColor={SETTINGS_BLUE} />
                <Text>实时活动</Text>
                <Spacer />
                <SettingsAccessoryIcon systemName="chevron.right" />
              </HStack>
            </Button>
          </Section>

          <Section header={<Text>支持</Text>}>
            <Button
              buttonStyle="plain"
              action={() => setDestination("diagnostics")}
            >
              <HStack
                spacing={12}
                padding={{ vertical: 5 }}
                frame={{ minHeight: 44, maxWidth: "infinity" }}
                contentShape="rect"
              >
                <SettingsRowIcon systemName="doc.text.magnifyingglass" backgroundColor={SETTINGS_GRAY} />
                <Text>诊断日志</Text>
                <Spacer />
                {diagnosticCount ? (
                  <Text foregroundStyle="secondaryLabel" monospacedDigit>
                    {diagnosticCount}
                  </Text>
                ) : null}
                <SettingsAccessoryIcon systemName="chevron.right" />
              </HStack>
            </Button>
            <Button
              buttonStyle="plain"
              action={() => setDestination("privacy")}
            >
              <HStack
                spacing={12}
                padding={{ vertical: 5 }}
                frame={{ minHeight: 44, maxWidth: "infinity" }}
                contentShape="rect"
              >
                <SettingsRowIcon systemName="hand.raised" backgroundColor="#34A853" />
                <Text>隐私政策</Text>
                <Spacer />
                <SettingsAccessoryIcon systemName="chevron.right" />
              </HStack>
            </Button>
          </Section>

          <Section
            header={<Text>授权</Text>}
            footer={
              <VStack alignment="leading" spacing={4}>
                {authorizationNotice ? (
                  <Text font="footnote" lineSpacing={3} foregroundStyle="systemRed">
                    {authorizationNotice}
                  </Text>
                ) : null}
                <Text font="footnote" lineSpacing={3} foregroundStyle="secondaryLabel">
                  Access Key 用于激活脚本使用权限，并授权同步快递信息。请妥善保管，勿与他人分享。
                </Text>
              </VStack>
            }
          >
            <HStack spacing={12} frame={{ minHeight: 44 }}>
              <SettingsRowIcon systemName="key" backgroundColor={SETTINGS_ORANGE} />
              <SecureField
                title="Access Key"
                value={token}
                onChanged={(value) => {
                  setToken(value);
                  setNotice("");
                  setAuthorizationNotice("");
                }}
                prompt={authorization ? authorizationPrompt(authorization) : "Access Key"}
                frame={{ maxWidth: "infinity" }}
              />
              {token.trim() ? (
                <Button
                  title={configured ? "更新" : "保存"}
                  action={saveToken}
                  buttonStyle="plain"
                />
              ) : configured ? (
                <Button
                  action={manageConfiguredToken}
                  buttonStyle="plain"
                >
                  <Text foregroundStyle="secondaryLabel" monospacedDigit>
                    {authorizationLabel(authorization)}
                  </Text>
                </Button>
              ) : authorization ? (
                <Text foregroundStyle="secondaryLabel" monospacedDigit>
                  {authorizationLabel(authorization)}
                </Text>
              ) : null}
            </HStack>
          </Section>

          <Section header={<Text>关于</Text>}>
            <HStack
              spacing={12}
              padding={{ vertical: 5 }}
              frame={{ minHeight: 44, maxWidth: "infinity" }}
            >
              <SettingsAppIcon />
              <Text>派派助手</Text>
              <Spacer />
              <Text foregroundStyle="secondaryLabel" monospacedDigit>{SCRIPT_VERSION}</Text>
            </HStack>
            <Link url={PROJECT_URL}>
              <HStack
                spacing={12}
                padding={{ vertical: 5 }}
                frame={{ minHeight: 44, maxWidth: "infinity" }}
                contentShape="rect"
              >
                <SettingsRowIcon systemName="link" backgroundColor={SETTINGS_GRAY} />
                <Text foregroundStyle="label">项目地址</Text>
                <Spacer />
                <Text foregroundStyle="secondaryLabel">GitHub</Text>
                <SettingsAccessoryIcon systemName="arrow.up.right" />
              </HStack>
            </Link>
          </Section>
        </RootTabList>
      </VStack>
    </NavigationStack>
  );
}
