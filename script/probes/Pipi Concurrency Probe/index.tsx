import { Button, List, Navigation, NavigationStack, Script, Section, Text, useState } from "scripting";
import { readReports, reportLines, runProbe } from "./probe";

function Results({ current }: { current: Awaited<ReturnType<typeof runProbe>> }) {
  const [reports, setReports] = useState(readReports());
  return <NavigationStack>
    <List navigationTitle="File publication probe">
      <Section>
        <Text>Synthetic data only. This does not test or repair delivery transactions.</Text>
        <Text>Add this script as a Home Screen widget, then reopen this page to read its result. An in-app preview is not widget-host evidence.</Text>
        <Button title="Read widget results" action={() => setReports(readReports())} />
      </Section>
      {(reports.some((report) => report.host === "app") ? reports : [current, ...reports]).map((report) =>
        <Section key={report.host}>
          {reportLines(report).map((line, index) => <Text key={index}>{line}</Text>)}
        </Section>)}
      <Section><Text>Matching shared witnesses establish visibility. Concurrent claims and transaction recovery still require separate tests.</Text></Section>
    </List>
  </NavigationStack>;
}

async function run() {
  try {
    const current = await runProbe("app");
    await Navigation.present({ element: <Results current={current} /> });
  }
  finally { Script.exit(); }
}
void run();
