import { AppEvents, Button, Link, List, Script, Section, Text, useEffect, useState } from "scripting";
import { ParcelLiveActivityCard } from "../components/ParcelLiveActivityCard";
import {
  parcelActivityStatus,
  startAllParcelActivities,
  startParcelActivity,
  stopParcelActivity,
} from "../services/parcel-live-activity";
import {
  HANDOFF_ACTIVITY_PREVIEW,
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
        <Text>先添加“截屏”，再添加 Scripting 的“在 App 中运行脚本”。选择派派助手，把截屏结果设为参数。</Text>
        <Text>将指令设为“轻点背面”或操作按钮，在物流页直接运行。</Text>
      </Section>
      <Section header={<Text>识别短信</Text>}>
        <Text>在系统快捷指令中创建“信息”自动化，按发件人或内容筛选。添加 Scripting 的“运行脚本”，把“快捷指令输入”的“内容”传给派派助手。正文为空时结束指令。</Text>
        <Text>打开派派助手查看识别结果。运单号可确认查询，独立取件码和寄件码在“取件”查看。</Text>
      </Section>
    </List>
  );
}

export function ParcelActivityPage({ cards, revision }: {
  cards: readonly ParcelActivityContent[];
  revision: number;
}) {
  const [activity, setActivity] = useState({ showAll: false, count: 0 });
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState("");
  const active = activity.showAll || activity.count > 0;
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
      <Section footer={activity.showAll ? <Text>{`已显示 ${activity.count} 张`}</Text> : undefined}>
        <Button title={activity.showAll ? "关闭实时活动" : "显示全部快递码"} disabled={busy}
          action={() => void change(activity.showAll ? stopParcelActivity : startAllParcelActivities)} />
      </Section>
      <Section header={<Text>取件码预览</Text>}>
        <ParcelLiveActivityCard
          data={PARCEL_ACTIVITY_PREVIEW}
          imageRoot={`${Script.directory}/assets/parcel-activity`}
          logoPath={`${Script.directory}/assets/parcel-activity/cainiao.png`}
          preview
        />
        <Button
          title={!activity.showAll && active ? "结束实时活动" : "在锁屏预览取件码"}
          disabled={busy || activity.showAll}
          action={() => void change(active ? stopParcelActivity : () => startParcelActivity())}
        />
      </Section>
      <Section header={<Text>寄件码预览</Text>}>
        <ParcelLiveActivityCard
          data={HANDOFF_ACTIVITY_PREVIEW}
          imageRoot={`${Script.directory}/assets/parcel-activity`}
          logoPath={`${Script.directory}/assets/platform-accounts/cainiao.png`}
          preview
        />
        <Button
          title="在锁屏预览寄件码"
          disabled={busy || active}
          action={() => void change(() => startParcelActivity(undefined, "handoff"))}
        />
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
