import {
  HStack,
  Image,
  List,
  Section,
  Text,
  Toggle,
  VStack,
  useState,
} from "scripting";
import type { StatusSemantic } from "../models";
import {
  IMPORTANT_NOTIFICATION_STATUSES,
  loadNotificationStatuses,
  REGULAR_NOTIFICATION_STATUSES,
  saveNotificationStatuses,
  setNotificationGroupEnabled,
} from "../services/notification-preferences";
import { transientToast } from "../services/ui-feedback";
import { statusLabel } from "../services/status";

type NotificationGroupProps = {
  title: string;
  subtitle: string;
  statuses: readonly StatusSemantic[];
  enabled: readonly StatusSemantic[];
  onToggleGroup: (statuses: readonly StatusSemantic[], value: boolean) => void;
  onToggleStatus: (semantic: StatusSemantic, value: boolean) => void;
};

function NotificationGroup(props: NotificationGroupProps) {
  const allEnabled = props.statuses.every((semantic) =>
    props.enabled.includes(semantic)
  );
  return (
    <>
      <Toggle
        value={allEnabled}
        onChanged={(value) => props.onToggleGroup(props.statuses, value)}
        toggleStyle="switch"
      >
        <VStack alignment="leading" spacing={3}>
          <Text font={17} fontWeight="semibold">{props.title}</Text>
          <Text font={13} foregroundStyle="secondaryLabel">
            {props.subtitle}
          </Text>
        </VStack>
      </Toggle>
      {props.statuses.map((semantic) => (
        <Toggle
          key={semantic}
          value={props.enabled.includes(semantic)}
          onChanged={(value) => props.onToggleStatus(semantic, value)}
          toggleStyle="switch"
        >
          <HStack spacing={10}>
            <Image
              systemName="arrow.turn.down.right"
              font={12}
              foregroundStyle="tertiaryLabel"
            />
            <Text>{statusLabel(semantic)}</Text>
          </HStack>
        </Toggle>
      ))}
    </>
  );
}

export function NotificationSettingsPage(props: {
  onChanged?: (enabledCount: number) => void;
}) {
  const [enabled, setEnabled] = useState<StatusSemantic[]>(
    () => loadNotificationStatuses(true),
  );
  const [notice, setNotice] = useState("");

  function save(next: readonly StatusSemantic[]) {
    try {
      const saved = saveNotificationStatuses(next);
      setEnabled(saved);
      setNotice("通知设置已保存");
      props.onChanged?.(saved.length);
    } catch {
      setNotice("保存失败，请稍后重试");
    }
  }

  function toggleStatus(semantic: StatusSemantic, value: boolean) {
    save(value
      ? [...enabled, semantic]
      : enabled.filter((current) => current !== semantic));
  }

  function toggleGroup(
    statuses: readonly StatusSemantic[],
    value: boolean,
  ) {
    save(setNotificationGroupEnabled(enabled, statuses, value));
  }

  return (
    <List
      navigationTitle="通知管理"
      navigationBarTitleDisplayMode="inline"
      toast={transientToast(notice, setNotice)}
    >
      <Section
        header={<Text>包裹物流消息</Text>}
      >
        <NotificationGroup
          title="重要物流节点"
          subtitle="已揽件、派送中、待取件及异常件"
          statuses={IMPORTANT_NOTIFICATION_STATUSES}
          enabled={enabled}
          onToggleGroup={toggleGroup}
          onToggleStatus={toggleStatus}
        />
      </Section>
      <Section
        footer={
          <Text font={12} foregroundStyle="secondaryLabel">
            仅在快递更新至已开启的状态时发送通知。
          </Text>
        }
      >
        <NotificationGroup
          title="常规物流消息"
          subtitle="已下单、已发货、运输中及已签收状态"
          statuses={REGULAR_NOTIFICATION_STATUSES}
          enabled={enabled}
          onToggleGroup={toggleGroup}
          onToggleStatus={toggleStatus}
        />
      </Section>
    </List>
  );
}
