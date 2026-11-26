import { AppEvents, HStack, Link, List, Picker, Section, Spacer, Text, Toggle, VStack, useEffect, useRef, useState } from "scripting";
import { ParcelActivityPreviewCard } from "../components/PickupTabCard";
import { SectionIconButton } from "../components/SectionIconButton";
import {
  onParcelActivityChanged,
  parcelActivityStatus,
  setParcelLockScreenStyle,
  startAllParcelActivities,
  startParcelActivityPreview,
  stopParcelActivity,
  stopParcelActivityPreview,
} from "../services/parcel-live-activity";
import { ParcelActivityError } from "../services/parcel-activity-action";
import type { ParcelLockScreenStyle } from "../services/parcel-card-appearance";
import { PICKUP_TAB_TITLE } from "../services/parcel-pickup";
import { SCREEN_SHORTCUT_INSTALL_URL } from "../services/shortcut-capture";
import { transientToast } from "../services/ui-feedback";

export function ParcelShortcutPage() {
  return (
    <List navigationTitle="快捷指令" navigationBarTitleDisplayMode="inline">
      <Section header={<Text>截屏识别</Text>}>
        <Link url={SCREEN_SHORTCUT_INSTALL_URL}>
          <Text>添加 Pipi 快捷指令</Text>
        </Link>
        <VStack alignment="leading" spacing={10} padding={{ vertical: 4 }}>
          <Text font="subheadline" lineSpacing={3}>在物流页或取餐订单页运行 Pipi。可用控制中心、操作按钮或轻点背面触发。</Text>
          <Text font="subheadline" lineSpacing={3}>收到瑞幸提示后，3 秒内打开取餐码，指令会自动二次识别。</Text>
          <Text font="footnote" lineSpacing={3} foregroundStyle="secondaryLabel">识别到运单号后，后台查询并通知最新轨迹。需验证时，在通知中输入手机尾号。取餐码会加入「待取」。</Text>
        </VStack>
      </Section>
      <Section header={<Text>短信识别</Text>}>
        <VStack alignment="leading" spacing={10} padding={{ vertical: 4 }}>
          <Text font="subheadline" lineSpacing={3}>1. 在「快捷指令」中创建「信息」自动化，按发件人或短信内容设置触发条件。</Text>
          <Text font="subheadline" lineSpacing={3}>2. 添加 Scripting 的「运行意图脚本」，选择「派派助手」。在参数栏选择「快捷指令输入」，再选它的「内容」作为短信正文。</Text>
          <Text font="subheadline" lineSpacing={3}>3. 如果要跳过空短信，在运行脚本前检查正文。正文为空时，停止这条快捷指令。</Text>
          <Text font="footnote" lineSpacing={3} foregroundStyle="secondaryLabel">
            {`识别到运单号后，打开派派助手确认查询。取件码和寄件码在「${PICKUP_TAB_TITLE}」中查看。`}
          </Text>
        </VStack>
      </Section>
    </List>
  );
}

export function ParcelActivityPage() {
  const [activity, setActivity] = useState({
    showAll: false, previewing: false, lockScreenStyle: "dynamic" as ParcelLockScreenStyle,
  });
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    function reload() {
      void parcelActivityStatus(false).then(status => {
        if (mounted.current) setActivity(status);
      }).catch(() => {
        if (mounted.current) setNotice("实时活动状态读取失败");
      }).finally(() => {
        if (mounted.current) setBusy(false);
      });
    }
    reload();
    const unsubscribe = onParcelActivityChanged(change => { if (change.kind === "preview") reload(); });
    const observe = (phase: "active" | "inactive" | "background") => {
      if (phase === "active") reload();
    };
    AppEvents.scenePhase.addListener(observe);
    return () => {
      mounted.current = false;
      unsubscribe();
      AppEvents.scenePhase.removeListener(observe);
    };
  }, []);

  // Only the service's own messages reach the page; a host or storage error shows the fallback (G-HIGH-18). A page
  // that has gone away while the action ran is left alone.
  async function change(action: () => Promise<void>, lockScreenStyle?: ParcelLockScreenStyle) {
    if (busy) return;
    setBusy(true);
    if (lockScreenStyle) setActivity(current => ({ ...current, lockScreenStyle }));
    try {
      await action();
    } catch (error) {
      if (mounted.current) {
        setNotice(error instanceof ParcelActivityError && error.message ? error.message : "实时活动操作失败，请稍后重试");
      }
    } finally {
      if (mounted.current) {
        try {
          const status = await parcelActivityStatus(false);
          if (mounted.current) setActivity(status);
        } catch {
          if (mounted.current) setNotice("实时活动状态读取失败");
        } finally {
          if (mounted.current) setBusy(false);
        }
      }
    }
  }

  const closePreview = () => void change(stopParcelActivityPreview);
  return (
    <List navigationTitle="实时活动" navigationBarTitleDisplayMode="inline" toast={transientToast(notice, setNotice)}>
      <Section>
        <Toggle title="实时活动" value={activity.showAll} disabled={busy}
          onChanged={(enabled) => void change(enabled ? startAllParcelActivities : stopParcelActivity)} />
      </Section>
      <Section>
        <Picker title="锁屏样式" value={activity.lockScreenStyle} pickerStyle="menu" disabled={busy}
          onChanged={(value: string) => {
            const style = value as ParcelLockScreenStyle;
            void change(() => setParcelLockScreenStyle(style), style);
          }}>
          <Text tag="dynamic">动态</Text>
          <Text tag="black">纯黑</Text>
          <Text tag="white">纯白</Text>
        </Picker>
      </Section>
      <Section header={
        <HStack>
          <Text>锁屏预览</Text>
          <Spacer />
          <SectionIconButton
            title={activity.previewing ? "结束预览" : "开始预览"}
            symbol={activity.previewing ? "stop.circle" : "play.circle"}
            disabled={busy}
            action={activity.previewing ? closePreview : () => void change(startParcelActivityPreview)}
          />
        </HStack>
      }>
        <ParcelActivityPreviewCard lockScreenStyle={activity.lockScreenStyle}
          onComplete={activity.previewing ? closePreview : undefined} actionPending={busy} />
      </Section>
    </List>
  );
}
