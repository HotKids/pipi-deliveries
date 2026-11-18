import { EXPRESS_TOAST_COPY } from "../services/express-toast-copy";
import {
  Button,
  HStack,
  Image,
  List,
  ProgressView,
  Section,
  Spacer,
  Text,
  VStack,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "scripting";
import type { AccountBinding, RefreshSummary } from "../models";
import { EXPRESS_POLICY } from "../contracts/express-policy.generated";
import { writeDiagnostic } from "../services/logger";
import { SCRIPT_BINDING_SOURCE } from "../services/script-source";
import {
  errorMessage,
  refreshSummaryToast,
  transientToast,
} from "../services/ui-feedback";
import { PhoneBindingPage } from "./PhoneBindingPage";
import { SettingsRowIcon } from "../components/SettingsRowIcon";
import { PlatformIcon, presentPlatformLogin } from "./PlatformAccountPages";
import { SamsungAssistantPage } from "./SamsungAssistantPage";
import {
  accountStatus, clearPlatformLogin, onPlatformAccountsChanged, platformAccountSubtitle, PLATFORM_NAMES, PLATFORM_SOURCES,
  type AccountStatus, type ExpressPlatform,
} from "../services/platform-accounts";
import type { PlatformSyncProgress } from "../services/platform-parcel-sync";
import { existingEnhancementIdentity, EnhancementIdentityMissing } from "../services/enhanced-account";
import { EnhancementUnbindUnavailable } from "../services/enhancement-unsubscribe";

const ACCOUNT_ICON_SIZE = 32;
const XIAOMI_BRAND_ORANGE = "#FF6900";

type MaybeAsync = void | Promise<void>;

export type PhoneManagerPageProps = {
  bindings: readonly AccountBinding[];
  stateRevision: number;
  busy: boolean;
  notice?: string;
  pendingEnhancementUnsubscribeCount?: number;
  unresolvedEnhancementUnsubscribeCount?: number;
  onSendCode: (phone: string, flowId: string, enhanced: boolean) => MaybeAsync;
  onBind: (phone: string, code: string, flowId: string, enhanced: boolean) => MaybeAsync;
  onRemove: (binding: AccountBinding, localOnly?: boolean) => MaybeAsync;
  onRefresh: () => Promise<RefreshSummary>;
  onPlatformRefresh: (platform: ExpressPlatform | undefined, onProgress: PlatformSyncProgress) => Promise<string>;
};

export function PhoneManagerPage(props: PhoneManagerPageProps) {
  const [localBusy, setLocalBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [enhancementNotice, setEnhancementNotice] = useState("");
  const [bindingDestination, setBindingDestination] = useState<"phone" | "samsung" | undefined>(undefined);
  const [bindingTarget, setBindingTarget] = useState<AccountBinding | undefined>(undefined);
  const [platformRevision, setPlatformRevision] = useState(0);
  const [syncingPlatforms, setSyncingPlatforms] = useState<readonly ExpressPlatform[]>([]);
  const mountedRef = useRef(true);
  const actionInFlightRef = useRef(false);
  const bindingGenerationRef = useRef(0);

  const visibleBindings = props.bindings.filter(
    (binding) => binding.source === SCRIPT_BINDING_SOURCE,
  );
  const busy = props.busy || localBusy;
  const samsungCount = visibleBindings.filter(binding => binding.enhancedMode).length;
  const hasEnhancement = samsungCount > 0;
  const unsubscribeNotice = !props.pendingEnhancementUnsubscribeCount ? ""
    : props.unresolvedEnhancementUnsubscribeCount
      ? "部分退订记录无法确认原订阅身份，无法自动重试；已保留待处理记录，远端退订尚未确认。"
      : "远端退订尚未确认，已保留待处理记录；将在原身份可用时重试。";

  useEffect(() => {
    if (!hasEnhancement) { setEnhancementNotice(""); return; }
    try {
      setEnhancementNotice(existingEnhancementIdentity() ? "" : new EnhancementIdentityMissing().message);
    } catch (error) {
      setEnhancementNotice(errorMessage(error, "增强模式身份读取失败，请稍后重试"));
    }
  }, [props.stateRevision, hasEnhancement]);

  useEffect(() => {
    const unsubscribe = onPlatformAccountsChanged(() => setPlatformRevision((value) => value + 1));
    return () => {
      mountedRef.current = false;
      unsubscribe();
    };
  }, []);

  useEffect(() => {
    writeDiagnostic("manager.rendered", {
      activeSource: SCRIPT_BINDING_SOURCE,
      revision: props.stateRevision,
      v5Bindings: visibleBindings.length,
    });
  }, [props.stateRevision, visibleBindings.length]);

  useEffect(() => {
    if (props.notice) setNotice(props.notice);
  }, [props.notice]);

  async function runAction(
    action: () => MaybeAsync,
    fallback: string,
    success = "",
  ) {
    if (props.busy || actionInFlightRef.current) return;
    actionInFlightRef.current = true;
    setLocalBusy(true);
    setNotice("");
    try {
      await action();
      if (mountedRef.current && success) setNotice(success);
    } catch (error) {
      if (mountedRef.current) setNotice(errorMessage(error, fallback));
    } finally {
      actionInFlightRef.current = false;
      if (mountedRef.current) setLocalBusy(false);
    }
  }

  async function refresh() {
    // Same gesture and same call as HomePage.refresh, so it reports through the same helper:
    // refreshAllShipments resolves with failed > 0 rather than rejecting, which runAction's
    // "did it throw" success argument read as 刷新完成. The action sets its own notice and
    // runAction supplies only the failure fallback — the shape remove() already uses.
    await runAction(async () => {
      // 上游文案不外露：拒绝也只报统一的「刷新失败」（AGENTS §11 统一表）。
      const summary = await props.onRefresh().catch(() => null);
      if (mountedRef.current) {
        setNotice(summary ? refreshSummaryToast(summary) : EXPRESS_TOAST_COPY.refreshFailed);
      }
    }, EXPRESS_TOAST_COPY.refreshFailed);
  }

  function add() {
    if (busy) return;
    setBindingTarget(undefined);
    changeBindingPresentation(true);
  }

  function changeBindingPresentation(presented: boolean, destination: "phone" | "samsung" = "phone") {
    bindingGenerationRef.current += 1;
    setBindingDestination(presented ? destination : undefined);
  }

  function openSamsung() {
    if (busy) return;
    setBindingTarget(undefined);
    changeBindingPresentation(true, "samsung");
  }

  async function bind(phone: string, code: string, flowId: string, enhanced: boolean) {
    const generation = bindingGenerationRef.current;
    await props.onBind(phone, code, flowId, enhanced);
    if (!mountedRef.current || generation !== bindingGenerationRef.current) return;
    changeBindingPresentation(false);
    setNotice(enhanced ? "验证成功" : EXPRESS_TOAST_COPY.phoneBound);
  }

  async function remove(binding: AccountBinding) {
    await runAction(async () => {
      const confirmed = await Dialog.confirm({
        title: "解绑手机号",
        message: `解绑后，将不再同步与 ${binding.phone} 关联的快递。`,
        cancelLabel: "取消",
        confirmLabel: "解绑",
      });
      if (!confirmed) return;
      try { await props.onRemove(binding); }
      catch (error) {
        if (!(error instanceof EnhancementUnbindUnavailable) || !binding.enhancedMode || !mountedRef.current) throw error;
        if (!binding.enhancedIdentityFingerprint) {
          const choice = await Dialog.actionSheet({
            title: "解绑手机号",
            message: "此绑定需重新验证三星生活助手后才能远端解绑。仅解除本机绑定无法确认远端退订，也无法自动重试。",
            actions: [
              { label: "重新验证" },
              { label: "仅解除本机绑定", destructive: true },
            ],
          });
          if (!mountedRef.current) return;
          if (choice === 0) {
            setBindingTarget(binding);
            changeBindingPresentation(true);
            return;
          }
          if (choice !== 1) return;
        }
        const localOnly = await Dialog.confirm({
          title: "远端解绑未完成",
          message: binding.enhancedIdentityFingerprint
            ? "本机解绑后将停止同步，远端订阅可能仍保留。将保留退订记录，仅在原身份可确认且可用时重试。"
            : "本机解绑后将停止同步，远端退订尚未确认。将保留待处理记录，但无法自动重试。",
          cancelLabel: "保留绑定",
          confirmLabel: "仍要解除本机绑定",
        });
        if (!localOnly) throw error;
        if (!mountedRef.current) return;
        await props.onRemove(binding, true);
      }
      if (mountedRef.current) setNotice(EXPRESS_TOAST_COPY.phoneUnbound);
    }, EXPRESS_TOAST_COPY.unbindFailed);
  }

  async function syncPlatforms(platform?: ExpressPlatform) {
    try {
      const result = await props.onPlatformRefresh(platform, (source, running) => {
        if (!mountedRef.current) return;
        setSyncingPlatforms(current => running ? [...current, source] : current.filter(item => item !== source));
      });
      if (mountedRef.current) setNotice(result);
    } finally {
      if (mountedRef.current) setSyncingPlatforms([]);
    }
  }

  async function managePlatform(platform: ExpressPlatform) {
    await runAction(async () => {
      const current = accountStatus(platform);
      const name = PLATFORM_NAMES[platform];
      if (current.state === "active") {
        const confirmed = await Dialog.confirm({
          title: `退出${name}账号`, message: `退出后，将停止同步该账号的快递信息。`,
          cancelLabel: "取消", confirmLabel: "退出",
        });
        if (confirmed && clearPlatformLogin(platform, current.generation) && mountedRef.current) setNotice("已退出登录");
        return;
      }
      if (await presentPlatformLogin(platform)) await syncPlatforms(platform);
    }, "账号操作失败，请重试。");
  }

  const platformAccounts = useMemo(() => PLATFORM_SOURCES.map((platform) => ({
    platform, ...accountStatus(platform),
  })), [platformRevision]);
  const samsungState: AccountStatus["state"] = !hasEnhancement ? "offline" : enhancementNotice ? "expired" : "active";
  const samsungSubtitle = unsubscribeNotice ? "退订待确认" :
    samsungState === "active" ? `已验证 ${samsungCount} 个手机号` : "";

  return (
    <List
      navigationTitle="管理账号"
      navigationBarTitleDisplayMode="inline"
      refreshable={refresh}
      toast={transientToast(notice, setNotice)}
      navigationDestination={{
        isPresented: Boolean(bindingDestination),
        onChanged: (presented) => { if (!presented) changeBindingPresentation(false); },
        content: bindingDestination === "samsung" ? (
          <SamsungAssistantPage
            key={`samsung:${bindingGenerationRef.current}`}
            bindings={visibleBindings}
            identityNotice={enhancementNotice}
            unsubscribeNotice={unsubscribeNotice}
            onSendCode={props.onSendCode}
            onBind={props.onBind}
          />
        ) : (
          <PhoneBindingPage
            bindings={props.bindings}
            key={`binding:${bindingGenerationRef.current}`}
            initialPhone={bindingTarget?.phone}
            purpose={bindingTarget ? "samsung" : undefined}
            onSendCode={props.onSendCode}
            onBind={bind}
          />
        ),
      }}
      toolbar={{
        topBarTrailing: (
          <Button
            buttonStyle="plain"
            action={add}
            disabled={busy}
          >
            <Image
              systemName="plus"
              font={17}
              frame={{ width: 44, height: 44 }}
            />
          </Button>
        ),
      }}
    >
      <Section
        header={
          <Text>
            {`手机号同步（${visibleBindings.length}/${EXPRESS_POLICY.sources.maxBindingsPerSource}）`}
          </Text>
        }
        footer={
          <Text font="footnote" lineSpacing={3} foregroundStyle="secondaryLabel">
            绑定手机号后，自动同步关联的快递信息。最多可绑定 {EXPRESS_POLICY.sources.maxBindingsPerSource} 个手机号。
          </Text>
        }
      >
        {visibleBindings.length ? (
          visibleBindings.map((binding) => (
            <HStack
              key={`${binding.source}:${binding.phone}`}
              spacing={12}
              padding={{ vertical: 6 }}
              trailingSwipeActions={{
                allowsFullSwipe: false,
                actions: [
                  <Button
                    title="解绑"
                    role="destructive"
                    action={() => remove(binding)}
                    disabled={busy}
                  />,
                ],
              }}
            >
              <SettingsRowIcon systemName="phone.fill" backgroundColor={XIAOMI_BRAND_ORANGE} size={ACCOUNT_ICON_SIZE} />
              <Text font="body" monospacedDigit>
                {binding.phone}
              </Text>
              <Spacer />
              <Text font="footnote" foregroundStyle="secondaryLabel">
                已绑定
              </Text>
            </HStack>
          ))
        ) : (
          <VStack
            spacing={8}
            padding={{ vertical: 28 }}
            frame={{ maxWidth: "infinity" }}
          >
            <Image
              systemName="iphone"
              font={32}
              foregroundStyle="tertiaryLabel"
            />
            <Text font="subheadline" fontWeight="medium">尚未绑定手机号</Text>
            <Text font="footnote" foregroundStyle="secondaryLabel">
              点按右上角的添加按钮
            </Text>
          </VStack>
        )}
      </Section>
      <Section
        header={
          <HStack>
            <Text>更多数据源</Text>
            <Spacer />
            <Button title="立即同步" systemImage="arrow.clockwise" labelStyle="iconOnly" disabled={busy ||
              !platformAccounts.some((item) => item.state === "active")}
              action={() => void runAction(() => syncPlatforms(), "同步失败，请稍后重试。")} />
          </HStack>
        }
        footer={
          <Text font="footnote" lineSpacing={3} foregroundStyle="secondaryLabel">
            登录后可获取已绑定手机号关联的快递信息，包括运单号、取件码、商品名称、商品图片和预计送达时间等。菜鸟和拼多多支持查看驿站身份码。拼多多支持同步在途快递，丰巢支持一键开柜。
          </Text>
        }
      >
        {platformAccounts.map(account => (
          <PlatformAccountRow
            key={account.platform}
            platform={account.platform}
            title={PLATFORM_NAMES[account.platform]}
            subtitle={platformAccountSubtitle(account)}
            state={account.state}
            syncing={syncingPlatforms.includes(account.platform)}
            disabled={busy}
            onTap={() => void managePlatform(account.platform)}
          />
        ))}
        <PlatformAccountRow
          platform="samsung"
          title="三星生活助手"
          subtitle={samsungSubtitle}
          state={samsungState}
          disabled={busy}
          onTap={openSamsung}
        />
      </Section>
    </List>
  );
}

function PlatformAccountRow({ platform, title, subtitle, state, syncing, disabled, onTap }: {
  platform: ExpressPlatform | "samsung";
  title: string;
  subtitle: string;
  state: AccountStatus["state"];
  syncing?: boolean;
  disabled: boolean;
  onTap: () => void;
}) {
  const copy = {
    active: { status: "已登录", subtitle: "尚未同步" },
    expired: { status: "已失效", subtitle: "请重新登录" },
    offline: { status: "未登录", subtitle: "" },
  }[state];
  return (
    <Button buttonStyle="plain" disabled={disabled} action={onTap}>
      <HStack spacing={12} padding={{ vertical: 6 }} contentShape="rect">
        {syncing ? (
          <ProgressView progressViewStyle="circular" frame={{ width: ACCOUNT_ICON_SIZE, height: ACCOUNT_ICON_SIZE }} />
        ) : (
          <PlatformIcon platform={platform} size={ACCOUNT_ICON_SIZE} />
        )}
        <VStack alignment="leading" spacing={3}>
          <Text font="body" fontWeight="medium" foregroundStyle="label">{title}</Text>
          {subtitle || copy.subtitle ? (
            <Text font="footnote" lineSpacing={2} foregroundStyle="secondaryLabel">{subtitle || copy.subtitle}</Text>
          ) : null}
        </VStack>
        <Spacer />
        <Text font="footnote" foregroundStyle="secondaryLabel" fixedSize={{ horizontal: true, vertical: false }}>{copy.status}</Text>
      </HStack>
    </Button>
  );
}
