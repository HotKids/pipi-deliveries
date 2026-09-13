import { Text, VStack, Widget } from "scripting";
import { runProbe } from "./probe";

async function run() {
  const family = String(Widget.family);
  if (family !== "systemSmall" && family !== "systemMedium") {
    Widget.present(<Text>Use a small or medium widget.</Text>);
  } else {
    const report = await runProbe(family === "systemSmall" ? "widget-small" : "widget-medium");
    Widget.present(<VStack>
      <Text>File publication probe</Text>
      <Text>{report.passed ? "CHECKS PASSED" : "CHECK FAILED"}</Text>
      <Text>{report.host}</Text>
      <Text>Open script for results.</Text>
    </VStack>);
  }
}
void run();
