import { AppEvents, Button, HStack, Link, List, Rectangle, Script, Section, Spacer, Text, Toggle, VStack, useEffect, useState } from "scripting";
import { ParcelLiveActivityCard } from "../components/ParcelLiveActivityCard";
import {
  parcelActivityStatus,
  startAllParcelActivities,
  startParcelActivity,
  startParcelActivityPreview,
  stopParcelActivity,
  stopParcelActivityPreview,
} from "../services/parcel-live-activity";
import {
  PARCEL_ACTIVITY_PREVIEW,
  type ParcelActivityContent,
} from "../services/parcel-pickup";
import { transientToast } from "../services/ui-feedback";

export function ParcelShortcutPage() {
  return (
    <List navigationTitle="快捷指令" navigationBarTitleDisplayMode="inline">
      <Section header={<Text>识别当前屏幕</Text>}>
        <Link url="shortcuts://create-shortcut">
          <Text>新建截屏识别指令</Text>
        </Link>
        <Text>1. 添加「截屏」。</Text>
        <Text>2. 在 Scripting 的动作列表中选「在 App 中运行意图」。选择「派派助手」，参数选上一步的截屏图像。</Text>
        <Text>3. 将这条指令设为「轻点背面」或「操作按钮」，打开物流页面后运行。</Text>
      </Section>
      <Section header={<Text>识别短信</Text>}>
        <Text>1. 在「快捷指令」的「自动化」中创建「信息」自动化，按发件人或内容筛选。</Text>
        <Text>2. 添加 Scripting 的「运行意图脚本」，选择「派派助手」。参数选「快捷指令输入」的「内容」，正文为空时结束。</Text>
        <Text>3. 打开派派助手确认运单查询，取件码和寄件码在「取件」查看。</Text>
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
          <Text>取件码预览</Text>
          <Spacer />
          <Button
            title={activity.previewing ? "结束预览" : "锁屏预览"}
            buttonStyle="plain" foregroundStyle="systemBlue" disabled={busy}
            action={() => void change(activity.previewing ? stopParcelActivityPreview : startParcelActivityPreview)}
          />
        </HStack>
      }>
        <VStack spacing={0} frame={{ maxWidth: "infinity" }}
          listRowInsets={0} listRowBackground={<Rectangle fill="clear" />} listRowSeparator="hidden">
          <ParcelLiveActivityCard
            data={PARCEL_ACTIVITY_PREVIEW}
            imageRoot={`${Script.directory}/assets/parcel-activity`}
            logoPath={`${Script.directory}/assets/parcel-activity/cainiao.png`}
            preview
          />
        </VStack>
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
