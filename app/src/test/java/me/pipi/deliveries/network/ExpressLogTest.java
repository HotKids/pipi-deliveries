package me.pipi.deliveries.network;
import org.junit.Test;
import static org.junit.Assert.*;
public class ExpressLogTest {
 @Test public void envelopeHasMillisecondsFlowAndIosFieldNames() {
  try (ExpressLog.Scope ignored=ExpressLog.scope("refresh-test","list_pull","v6")) {
   String line=ExpressLog.format(0L,"INFO","detail.timeline.selected","timelineProvider","k100_h5", "statusProvider","v6_query","waybillTail","3089");
   assertTrue(line.startsWith("1970-01-01T00:00:00.000Z INFO detail.timeline.selected "));
   assertTrue(line.contains("flowId=refresh-test")); assertTrue(line.contains("trigger=list_pull"));
   assertTrue(line.contains("source=v6")); assertTrue(line.contains("statusProvider=v6_query"));
  }
  assertFalse(ExpressLog.format(0L,"INFO","test").contains("flowId="));
 }
}
