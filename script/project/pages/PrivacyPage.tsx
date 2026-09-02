import { List, Section, Text } from "scripting";

export function PrivacyPage() {
  return (
    <List
      navigationTitle="隐私政策"
      navigationBarTitleDisplayMode="inline"
    >
      <Section header={<Text>隐私声明</Text>}>
        <Text font={14} foregroundStyle="secondaryLabel">
          为完成手机号验证、快递同步与物流查询，必要的手机号、验证码、运单号、手机尾号、随机安装身份及网络信息会经 Cloudflare Worker 临时中转至相关服务。部分订单会在本机加载第三方页面以提取运单号。Worker 按当前设计不持久化保存业务数据；Access Key、快递列表与物流缓存保存在本机，第三方服务仍可能依据其政策处理必要的网络日志或 Cookie。
        </Text>
      </Section>

      <Section header={<Text>免责声明</Text>}>
        <Text font={14} foregroundStyle="secondaryLabel">
          本项目仅供学习、研究及个人非商业用途。部分功能依赖第三方接口，服务可能随时变更或停止；项目作者不保证查询结果与服务的准确性、完整性、及时性或持续可用性，相关风险由使用者承担。
        </Text>
      </Section>

      <Section header={<Text>传播限制</Text>}>
        <Text font={14} foregroundStyle="secondaryLabel">
          未经项目作者事先明确授权，不得在中华人民共和国大陆地区传播、分发、转载、镜像、再发布本项目脚本、源代码或任何衍生版本。
        </Text>
      </Section>

      <Section header={<Text>诊断日志</Text>}>
        <Text font={14} foregroundStyle="secondaryLabel">
          诊断日志仅保存在本机，最多保留 200 条并在 7 日后自动过期；不记录手机号、验证码、Access Key、运单号或响应正文，也不会自动上传。
        </Text>
      </Section>
    </List>
  );
}
