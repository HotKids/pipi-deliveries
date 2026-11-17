import { Button, HStack, Image, List, Section, Spacer, Text, VStack, useEffect, useRef, useState } from "scripting";
import { PhoneBindingPage, type PhoneBindingPageProps } from "./PhoneBindingPage";
import { SETTINGS_ORANGE, SettingsRowIcon } from "../components/SettingsRowIcon";
import { transientToast } from "../services/ui-feedback";

type SamsungAssistantPageProps = Pick<PhoneBindingPageProps, "bindings" | "onSendCode" | "onBind"> & {
  identityNotice: string;
  unsubscribeNotice: string;
};

export function SamsungAssistantPage(props: SamsungAssistantPageProps) {
  const [selectedPhone, setSelectedPhone] = useState("");
  const [notice, setNotice] = useState("");
  const formGeneration = useRef(0);
  useEffect(() => () => { formGeneration.current += 1; }, []);

  function selectPhone(phone: string) {
    formGeneration.current += 1;
    setSelectedPhone(phone);
  }

  async function verifyPhone(phone: string, code: string, flowId: string, enhanced: boolean) {
    const generation = formGeneration.current;
    await props.onBind(phone, code, flowId, enhanced);
    if (formGeneration.current !== generation) return;
    selectPhone("");
    setNotice("验证成功");
  }

  return (
    <List
      navigationTitle="三星生活助手"
      navigationBarTitleDisplayMode="inline"
      toast={transientToast(notice, setNotice)}
      navigationDestination={{
        isPresented: Boolean(selectedPhone),
        onChanged: (presented) => { if (!presented) selectPhone(""); },
        content: (
          <PhoneBindingPage
            key={`samsung:${formGeneration.current}`}
            bindings={props.bindings}
            purpose="samsung"
            initialPhone={selectedPhone}
            onSendCode={props.onSendCode}
            onBind={verifyPhone}
          />
        ),
      }}
    >
      <Section header={<Text>已绑定手机号</Text>} footer={
        <VStack alignment="leading" spacing={6}>
          {props.bindings.length ? <Text>选择手机号验证后，可补充京东订单的运单号和商品图片。</Text> : null}
          {props.identityNotice ? <Text foregroundStyle="systemRed">{props.identityNotice}</Text> : null}
          {props.unsubscribeNotice ? <Text>{props.unsubscribeNotice}</Text> : null}
        </VStack>
      }>
        {props.bindings.length ? props.bindings.map((binding) => (
          <Button key={binding.phone} buttonStyle="plain" action={() => selectPhone(binding.phone)}>
            <HStack spacing={12} padding={{ vertical: 6 }} contentShape="rect">
              <SettingsRowIcon systemName="phone.fill" backgroundColor={SETTINGS_ORANGE} size={36} />
              <Text font={17} monospacedDigit>{binding.phone}</Text>
              <Spacer />
              <Text font={13} foregroundStyle="secondaryLabel">
                {binding.enhancedMode ? props.identityNotice ? "需重新验证" : "已验证" : "待验证"}
              </Text>
              <Image systemName="chevron.right" font={12} foregroundStyle="tertiaryLabel" />
            </HStack>
          </Button>
        )) : <Text foregroundStyle="secondaryLabel">请先在手机号同步中绑定手机号。</Text>}
      </Section>
    </List>
  );
}
