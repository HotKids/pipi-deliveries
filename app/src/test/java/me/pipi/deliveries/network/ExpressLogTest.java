package me.pipi.deliveries.network;
import org.junit.Test;
import static org.junit.Assert.*;
public class ExpressLogTest {
 @Test public void transferredScopeSharesCountersAndRestoresAfterFailure() throws Exception {
  java.util.concurrent.Callable<Void> operation;
  ExpressLog.Scope request;
  try (ExpressLog.Scope active = ExpressLog.detailScope("request", "detail_pull", "v6")) {
   request = active;
   operation = ExpressLog.withCurrentScope(() -> {
    assertTrue(ExpressLog.format(0L, "INFO", "started").contains("flowId=request "));
    ExpressLog.line("v6", "k100", "manual", "succeeded");
    throw new java.io.IOException("synthetic");
   });
  }
  try (ExpressLog.Scope ignored = ExpressLog.scope("worker", "background", "v5")) {
   try { operation.call(); fail("Expected the operation failure"); }
   catch (java.io.IOException expected) { assertEquals("synthetic", expected.getMessage()); }
   assertTrue(ExpressLog.format(0L, "INFO", "finished").contains("flowId=worker "));
  }
  assertEquals("unchanged", request.unchangedReason());
  assertFalse(ExpressLog.hasScope());
 }

 @Test public void envelopeHasMillisecondsFlowAndIosFieldNames() {
  try (ExpressLog.Scope ignored=ExpressLog.scope("refresh-test","list_pull","v6")) {
   String line=ExpressLog.format(0L,"INFO","detail.timeline.selected","timelineProvider","k100_h5", "statusProvider","v6_query","waybillTail","3089");
   assertTrue(line.startsWith("1970-01-01T00:00:00.000Z INFO detail.timeline.selected "));
   assertTrue(line.contains("flowId=refresh-test")); assertTrue(line.contains("trigger=list_pull"));
   assertTrue(line.contains("source=v6")); assertTrue(line.contains("statusProvider=v6_query"));
  }
  assertFalse(ExpressLog.format(0L,"INFO","test").contains("flowId="));
 }

 /** Audit R10: waybillTail is the last four of the normalized waybill (letters upper-cased, separators gone). */
 @Test public void waybillTailIsTakenFromTheNormalizedWaybill() {
  assertEquals("4547", ExpressLog.tail(" jt-4006 8395 6454 7 "));
  assertEquals("12AB", ExpressLog.tail("sf-12ab"));
  assertEquals("0007", ExpressLog.tail("YT0000000000007"));
  assertEquals("", ExpressLog.tail(null));
 }

 /**
  * Audit R10 (user 2026-09-25): a stage of a detail refresh is logged as iOS and Pipi log it,
  * detail.refresh.stage_started / _succeeded / _failed / _skipped, with Pipi's gateReason for a skip
  * and WARNING for a failure; it used to read manual.source.*.
  */
 @Test public void aDetailRefreshStageUsesTheStageEvents() {
  for (String trigger : new String[]{"detail_open", "detail_pull"}) {
   try (ExpressLog.Scope ignored=ExpressLog.scope("detail-test",trigger,"v5")) {
    String started=ExpressLog.lineText(0L,"v5","jd_h5","jingdong","started","tail","1234","reason","source_history_incomplete");
    assertTrue(started, started.startsWith("1970-01-01T00:00:00.000Z INFO detail.refresh.stage_started "));
    assertTrue(started, started.contains(" flowId=detail-test trigger="+trigger+" source=v5 "));
    assertTrue(started, started.contains(" stage=jd_h5 ") && started.contains(" waybillTail=1234"));
    String skipped=ExpressLog.lineText(0L,"v5","jd_h5","jingdong","skipped","tail","1234","reason","feed_pickup");
    assertTrue(skipped, skipped.startsWith("1970-01-01T00:00:00.000Z INFO detail.refresh.stage_skipped "));
    assertTrue(skipped, skipped.endsWith(" gateReason=feed_pickup"));
    String failed=ExpressLog.lineText(0L,"","k100_h5","","failed","tail","1234","reason","no_tracks");
    assertTrue(failed, failed.startsWith("1970-01-01T00:00:00.000Z WARNING detail.refresh.stage_failed "));
    assertTrue(failed, failed.endsWith(" errorCategory=no_tracks"));
    String succeeded=ExpressLog.lineText(0L,"","v6_query","manual","succeeded","nodes",3);
    assertTrue(succeeded, succeeded.startsWith("1970-01-01T00:00:00.000Z INFO detail.refresh.stage_succeeded "));
    // The transport's lines and other vocabularies keep their names inside a detail flow.
    assertTrue(ExpressLog.lineText(0L,"","http","","started").contains(" INFO manual.source.started "));
    assertTrue(ExpressLog.lineText(0L,"","k100_h5","","capture_finished").contains(" manual.source.capture_finished "));
    assertTrue(ExpressLog.lineText(0L,"v5","v5_query","","failed").contains(" WARNING refresh.stage.failed "));
   }
  }
 }

 /** Outside a detail refresh a provider call keeps manual.source.* and its skipReason. */
 @Test public void providerCallsOutsideADetailRefreshKeepTheSourceEvents() {
  String none=ExpressLog.lineText(0L,"v5","jd_h5","jingdong","skipped","tail","1234","reason","cooldown");
  assertTrue(none, none.contains(" INFO manual.source.skipped ") && none.endsWith(" skipReason=cooldown"));
  try (ExpressLog.Scope ignored=ExpressLog.scope("refresh-test","background","v5")) {
   String failed=ExpressLog.lineText(0L,"","v6_query","manual","failed","reason","IOException");
   assertTrue(failed, failed.contains(" WARNING manual.source.failed "));
  }
 }
}
