import { Button, HStack, Notification, Text, VStack, useRef, useState } from "scripting";
import { readScreenShortcutLookup, submitScreenShortcutPhoneTail } from "./services/parcel-shortcut";
import { showShortcutPickupActivities } from "./services/parcel-live-activity";

const DIGIT_ROWS = [["1", "2", "3"], ["4", "5", "6"], ["7", "8", "9"]] as const;

function PhoneTailInput({ token }: { token: string }) {
  const [tail, setTail] = useState("");
  const [message, setMessage] = useState("");
  const [querying, setQuerying] = useState(false);
  const [done, setDone] = useState(false);
  const submitting = useRef(false);

  async function submit() {
    if (submitting.current || tail.length !== 4) return;
    submitting.current = true;
    setQuerying(true);
    setMessage("");
    try {
      const result = await submitScreenShortcutPhoneTail(token, tail, showShortcutPickupActivities);
      setDone(result.done);
      setMessage(result.message);
    } finally {
      submitting.current = false;
      setQuerying(false);
    }
  }

  function addDigit(digit: string) {
    setTail((current) => current.length < 4 ? current + digit : current);
    setMessage("");
  }

  if (done) return <Text padding={12}>{message}</Text>;
  return (
    <VStack spacing={6} padding={12}>
      <Text font="subheadline">手机号后 4 位</Text>
      <Text font="title3" monospacedDigit padding={{ vertical: 4 }}>
        {tail.padEnd(4, "–").split("").join(" ")}
      </Text>
      {DIGIT_ROWS.map((row) => (
        <HStack key={row[0]} spacing={8}>
          {row.map((digit) => (
            <Button key={digit} buttonStyle="bordered" disabled={querying || tail.length === 4}
              action={() => addDigit(digit)}>
              <Text frame={{ minWidth: 44 }}>{digit}</Text>
            </Button>
          ))}
        </HStack>
      ))}
      <HStack spacing={8}>
        <Button buttonStyle="bordered" disabled={querying || !tail} action={() => {
          setTail((current) => current.slice(0, -1));
          setMessage("");
        }}>
          <Text frame={{ minWidth: 44 }}>删除</Text>
        </Button>
        <Button buttonStyle="bordered" disabled={querying || tail.length === 4} action={() => addDigit("0")}>
          <Text frame={{ minWidth: 44 }}>0</Text>
        </Button>
        <Button buttonStyle="borderedProminent" disabled={querying || tail.length !== 4} action={() => void submit()}>
          <Text frame={{ minWidth: 44 }}>{querying ? "查询中" : "查询"}</Text>
        </Button>
      </HStack>
      {message ? <Text font="footnote" foregroundStyle="secondaryLabel">{message}</Text> : null}
    </VStack>
  );
}

const token: unknown = Notification.current?.request.content.userInfo?.screenShortcutDraft;
void Notification.present(typeof token === "string" && readScreenShortcutLookup(token)
  ? <PhoneTailInput token={token} />
  : <Text padding={12}>此运单已处理。</Text>);
