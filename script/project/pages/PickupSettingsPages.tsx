import { AppEvents, Button, HStack, Link, List, Section, Spacer, Text, Toggle, useEffect, useState } from "scripting";
import { ParcelActivityPreviewCard } from "../components/PickupTabCard";
import { SectionIconButton } from "../components/SectionIconButton";
import {
  parcelActivityStatus,
  startAllParcelActivities,
  startParcelActivity,
  startParcelActivityPreview,
  stopParcelActivity,
  stopParcelActivityPreview,
} from "../services/parcel-live-activity";
import { PICKUP_TAB_TITLE, type ParcelActivityContent } from "../services/parcel-pickup";
import { transientToast } from "../services/ui-feedback";

export function ParcelShortcutPage() {
  return (
    <List navigationTitle="快捷指令" navigationBarTitleDisplayMode="inline">
      <Section header={<Text>截屏识别</Text>}>
        <Link url="shortcuts://create-shortcut">
          <Text>新建截屏快捷指令</Text>
        </Link>
        <Text font="subheadline" lineSpacing={3}>1. 添加「截屏」，再添加 Scripting 的「运行意图脚本」。</Text>
        <Text font="subheadline" lineSpacing={3}>2. 选择「派派助手」，在参数栏选择上一步生成的截屏。</Text>
        <Text font="subheadline" lineSpacing={3}>3. 打开要识别的物流页面，运行这条快捷指令。也可以在系统设置中用「轻点背面」或「操作按钮」触发。</Text>
        <Text font="footnote" lineSpacing={3} foregroundStyle="secondaryLabel">截屏在后台识别并保存。要在当前界面看到提示，可以接上「显示通知」，使用运行结果作为通知内容。</Text>
      </Section>
      <Section header={<Text>短信识别</Text>}>
        <Text font="subheadline" lineSpacing={3}>1. 在「快捷指令」中创建「信息」自动化，按发件人或短信内容设置触发条件。</Text>
        <Text font="subheadline" lineSpacing={3}>2. 添加 Scripting 的「运行意图脚本」，选择「派派助手」。在参数栏选择「快捷指令输入」，再选它的「内容」作为短信正文。</Text>
        <Text font="subheadline" lineSpacing={3}>3. 如果要跳过空短信，在运行脚本前检查正文。正文为空时，停止这条快捷指令。</Text>
        <Text font="footnote" lineSpacing={3} foregroundStyle="secondaryLabel">
          {`识别到运单号后，打开派派助手确认查询。取件码和寄件码在「${PICKUP_TAB_TITLE}」中查看。`}
        </Text>
      </Section>
    </List>
  );
}

export function ParcelActivityPage({ cards, revision }: {
  cards: readonly ParcelActivityContent[];
  revision: number;
}) {
  const [activity, setActivity] = useState({ showAll: false, count: 0, previewing: false });
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState("");
  const active = activity.showAll || activity.count > 0 || activity.previewing;
  const parcels = cards.flatMap((content) => content.target ? [{ content, target: content.target }] : [])
    .sort((left, right) => (right.content.capturedAtMs ?? 0) - (left.content.capturedAtMs ?? 0));

  useEffect(() => {
    let mounted = true;
    function reload() {
      void parcelActivityStatus().then((value) => {
        if (mounted) setActivity(value);
      }).catch(() => {
        if (mounted) setNotice("无法读取实时活动状态。");
      }).finally(() => {
        if (mounted) setBusy(false);
      });
    }
    reload();
    const observe = (phase: "active" | "inactive" | "background") => {
      if (phase === "active") reload();
    };
    AppEvents.scenePhase.addListener(observe);
    return () => {
      mounted = false;
      AppEvents.scenePhase.removeListener(observe);
    };
  }, [revision]);

  async function change(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await action();
    } catch (error) {
      setNotice(error instanceof Error && error.message ? error.message : "实时活动操作失败。");
    } finally {
      try {
        setActivity(await parcelActivityStatus());
      } catch {
        setNotice("无法读取实时活动状态。");
      } finally {
        setBusy(false);
      }
    }
  }

  return (
    <List navigationTitle="实时活动" navigationBarTitleDisplayMode="inline" toast={transientToast(notice, setNotice)}>
      <Section footer={activity.showAll && activity.count > 0 ? <Text>{`已显示 ${activity.count} 张`}</Text> : undefined}>
        <Toggle title="实时活动" value={activity.showAll} disabled={busy}
          onChanged={(enabled) => void change(enabled ? startAllParcelActivities : stopParcelActivity)} />
      </Section>
      <Section header={
        <HStack>
          <Text>锁屏预览</Text>
          <Spacer />
          <SectionIconButton
            title={activity.previewing ? "结束预览" : "开始预览"}
            symbol={activity.previewing ? "stop.circle" : "play.circle"}
            disabled={busy}
            action={() => void change(activity.previewing ? stopParcelActivityPreview : startParcelActivityPreview)}
          />
        </HStack>
      }>
        <ParcelActivityPreviewCard />
      </Section>
      {parcels.length ? (
        <Section header={<Text>快递码</Text>}>
          {parcels.map(({ content, target }) => (
            <Button
              key={"shipmentId" in target ? target.shipmentId : target.recordId}
              disabled={busy || active}
              title={[content.title, content.location, content.code].filter(Boolean).join(" · ")}
              action={() => void change(() => startParcelActivity(target))}
            />
          ))}
        </Section>
      ) : null}
    </List>
  );
}
