package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import java.util.List;
import java.util.regex.Pattern;

import me.pipi.deliveries.SharedExpressFixtures;
import me.pipi.deliveries.data.ManualTimelineAuthorityPolicy;
import me.pipi.deliveries.data.TimelineSlot;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.ExpressStatusNormalizer;
import me.pipi.deliveries.model.ExpressTimeline;
import me.pipi.deliveries.model.StatusSemantic;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/**
 * 「快递状态已更新」占位不显示（用户 2026-09-12 指示、2026-09-26 重申；审计 D2 / X4）：带不带「，点击查看」、全角或半角
 * 逗号、结尾有没有「>>」，四种写法都不当轨迹节点、不当列表头条。期望是 Worker 生成的共享词表
 * provider-line-vocabulary.v1.json 的 {@code displayed} 字段：客户端只看它，Worker 数据里照旧保留（{@code kept}）。
 */
public final class ProviderLineVocabularyTest {
    private static final String REAL_NODE = "【江门市】快件已由快递员揽收";

    @Test
    public void everySharedLineIsShownExactlyAsTheVocabularySays() throws Exception {
        JSONObject fixture = SharedExpressFixtures.load("provider-line-vocabulary.v1.json");
        JSONArray cases = fixture.getJSONArray("cases");
        assertTrue(cases.length() >= 16);
        Pattern shared = Pattern.compile(
                fixture.getJSONObject("vocabulary").getString("updateSummaryPattern"));
        // 用户 2026-10-01（第 6 项）：运输时效提醒也进了共享词表（transitTimeReminderPattern），与占位同类。
        Pattern reminder = Pattern.compile(
                fixture.getJSONObject("vocabulary").getString("transitTimeReminderPattern"));
        for (int index = 0; index < cases.length(); index++) {
            JSONObject value = cases.getJSONObject(index);
            String line = value.getString("line");
            String kind = value.getString("class");
            assertEquals(line, !value.getBoolean("displayed"),
                    ExpressStatusNormalizer.isNonEventDetail(line));
            // 用户 2026-09-26（其余裁决 19）：只有 kept=false 的行是报错行；占位四种写法都 kept=true。
            assertEquals(line, !value.getBoolean("kept"),
                    ExpressStatusNormalizer.isProviderErrorDetail(line));
            assertEquals(line, "updateSummary".equals(kind),
                    ExpressStatusNormalizer.isUpdateSummary(line));
            String compact = line.replaceAll("\\s+", "");
            assertEquals(line, shared.matcher(compact).matches() || reminder.matcher(compact).matches(),
                    ExpressStatusNormalizer.isUpdateSummary(line));
            if ("error".equals(kind)) {
                assertTrue(line, ExpressStatusNormalizer.isProviderErrorDetail(line));
            }
        }
        JSONObject vocabulary = fixture.getJSONObject("vocabulary");
        JSONArray prefixes = vocabulary.getJSONArray("errorPrefixes");
        for (int index = 0; index < prefixes.length(); index++) {
            String prefix = prefixes.getString(index);
            assertTrue(prefix, ExpressStatusNormalizer.isNonEventDetail(prefix + "，请稍后"));
            assertTrue(prefix, ExpressStatusNormalizer.isNonEventDetail(prefix.toUpperCase()));
        }
        JSONArray lines = vocabulary.getJSONArray("errorLines");
        for (int index = 0; index < lines.length(); index++) {
            assertTrue(lines.getString(index),
                    ExpressStatusNormalizer.isNonEventDetail(lines.getString(index)));
        }
    }

    /** The account list keeps the real node and drops every placeholder form, parcel and order alike. */
    @Test
    public void theAccountListDropsEveryPlaceholderFormAndKeepsTheRealNodes() throws Exception {
        JSONArray cases = SharedExpressFixtures.load("provider-line-vocabulary.v1.json")
                .getJSONArray("cases");
        int placeholders = 0;
        for (int index = 0; index < cases.length(); index++) {
            JSONObject value = cases.getJSONObject(index);
            if (!"updateSummary".equals(value.getString("class"))) continue;
            placeholders++;
            String line = value.getString("line");
            JSONArray details = new JSONArray()
                    .put(new JSONObject().put("time", "2026-09-20 12:00:00").put("desc", line))
                    .put(new JSONObject().put("time", "2026-09-20 10:00:00").put("desc", REAL_NODE));
            ExpressQueryResult parcel = ExpressDiscoveryClient.parseExpress(new JSONObject()
                    .put("mailNo", "YT7000000000001").put("cpCode", "YTO").put("name", "圆通速递")
                    .put("provider", "DouYin").put("stateNum", 103).put("details", details),
                    "", "13800000001");
            assertOnlyTheRealNode(line, parcel);
            ExpressQueryResult order = ExpressDiscoveryClient.parseAccountOrder(new JSONObject()
                    .put("mailNo", "3610448002878202").put("cpCode", "JDKD")
                    .put("name", "京东商品快递").put("provider", "JingDong").put("stateNum", 103)
                    .put("details", details));
            assertOnlyTheRealNode(line, order);
        }
        // 4 「快递状态已更新」 forms + 4 transit-time reminder forms (user 2026-10-01, item 6).
        assertEquals(8, placeholders);
    }

    /**
     * The interface-6 list headline never shows the placeholder either, and the row itself stays with
     * its structured status in all four forms: 「快递状态已更新，点击查看>>」 is no longer a provider error
     * that drops the whole row (user 2026-09-26, parity doc 其余裁决 19; this replaces the earlier
     * expectation that only that form was dropped). A real provider error line still drops it.
     */
    @Test
    public void theInterface6RowKeepsItsStatusButNeverShowsThePlaceholder() throws Exception {
        JSONArray cases = SharedExpressFixtures.load("provider-line-vocabulary.v1.json")
                .getJSONArray("cases");
        StatusSemantic listed = interface6Row(REAL_NODE).semantic;
        assertFalse(listed == StatusSemantic.UNKNOWN);
        int placeholders = 0;
        for (int index = 0; index < cases.length(); index++) {
            JSONObject value = cases.getJSONObject(index);
            String line = value.getString("line");
            ExpressQueryResult row = interface6Row(line);
            if ("error".equals(value.getString("class"))) {
                assertEquals(line, null, row);
                continue;
            }
            if (!"updateSummary".equals(value.getString("class"))) continue;
            placeholders++;
            assertNotNull(line, row);
            assertEquals(line, listed, row.semantic);
            assertEquals(line, "", row.latestDetail);
            assertEquals(line, "", row.latestTime);
        }
        // 4 「快递状态已更新」 forms + 4 transit-time reminder forms (user 2026-10-01, item 6).
        assertEquals(8, placeholders);
    }

    /**
     * The Meizu (v6_query) answer: a placeholder headline neither heads the package nor voids its
     * status; the real node heads it. With no real node the status alone is still an answer, where a
     * real provider error line is no result at all (user 2026-09-26, 其余裁决 19).
     */
    @Test
    public void theMeizuQueryKeepsItsStatusAndHeadsWithTheRealNode() throws Exception {
        JSONArray cases = SharedExpressFixtures.load("provider-line-vocabulary.v1.json")
                .getJSONArray("cases");
        StatusSemantic control = meizuAnswer(REAL_NODE, false).semantic;
        assertFalse(control == StatusSemantic.UNKNOWN);
        for (int index = 0; index < cases.length(); index++) {
            JSONObject value = cases.getJSONObject(index);
            String line = value.getString("line");
            String kind = value.getString("class");
            if ("error".equals(kind)) {
                try {
                    meizuAnswer(line, false);
                    org.junit.Assert.fail(line + ": a provider error without a real node is no result");
                } catch (ExpressApi.NoTrackException expected) {
                    // A real provider error keeps its treatment.
                }
                continue;
            }
            if (!"updateSummary".equals(kind)) continue;
            ExpressQueryResult withNode = meizuAnswer(line, true);
            assertEquals(line, control, withNode.semantic);
            assertEquals(line, REAL_NODE, withNode.latestDetail);
            assertEquals(line, "2026-09-20 10:00:00", withNode.latestTime);
            ExpressQueryResult statusOnly = meizuAnswer(line, false);
            assertEquals(line, control, statusOnly.semantic);
            assertEquals(line, "", statusOnly.latestDetail);
            assertTrue(line, ExpressTimeline.parse(statusOnly.tracksJson, "", "").isEmpty());
        }
    }

    /** A placeholder in a package never blocks lending its structured status (其余裁决 19). */
    @Test
    public void aPlaceholderNeverBlocksABorrowedStatus() throws Exception {
        JSONArray cases = SharedExpressFixtures.load("provider-line-vocabulary.v1.json")
                .getJSONArray("cases");
        for (int index = 0; index < cases.length(); index++) {
            JSONObject value = cases.getJSONObject(index);
            String line = value.getString("line");
            String tracks = new JSONArray()
                    .put(new JSONObject().put("time", "2026-09-20 12:00:00").put("context", line))
                    .put(new JSONObject().put("time", "2026-09-20 10:00:00").put("context", REAL_NODE))
                    .toString();
            ExpressQueryResult headed = new ExpressQueryResult("ZTOV6SYNTHETIC", "ZTO", "中通快递",
                    StatusSemantic.TRANSIT, "2026-09-20 12:00:00", line, "[]", "", "",
                    TimelineSlot.V6_QUERY).withManualStatusEvidence("运输中", true);
            ExpressQueryResult listed = new ExpressQueryResult("ZTOV6SYNTHETIC", "ZTO", "中通快递",
                    StatusSemantic.TRANSIT, "2026-09-20 10:00:00", REAL_NODE, tracks, "", "",
                    TimelineSlot.V6_QUERY).withManualStatusEvidence("运输中", true);
            boolean kept = value.getBoolean("kept");
            assertEquals(line, kept, ManualTimelineAuthorityPolicy.hasStructuredStatus(headed));
            assertEquals(line, kept, ManualTimelineAuthorityPolicy.hasStructuredStatus(listed));
        }
    }

    /**
     * 用户 2026-09-28「加进占位清单」：「您有包裹运输时效变化，请留意取件安排」（全角或半角逗号，结尾带不带「 >>」）与
     * 「快递状态已更新」占位同样处理：不当节点、不当头条，列表显示上一条真节点。只认这一句，别的「…>>」照常显示。
     */
    @Test
    public void theTransitTimeReminderIsAPlaceholderToo() throws Exception {
        // 用户 2026-10-01（第 6 项）：这句已补进 Worker 共用的占位词表；Lite 认的写法与共享 transitTimeReminderPattern 一致。
        Pattern shared = Pattern.compile(SharedExpressFixtures.load("provider-line-vocabulary.v1.json")
                .getJSONObject("vocabulary").getString("transitTimeReminderPattern"));
        for (String line : TRANSIT_TIME_REMINDERS) {
            assertTrue(line, shared.matcher(line.replaceAll("\\s+", "")).matches());
            assertTrue(line, ExpressStatusNormalizer.isUpdateSummary(line));
            assertTrue(line, ExpressStatusNormalizer.isNonEventDetail(line));
            assertFalse(line, ExpressStatusNormalizer.isProviderErrorDetail(line));
            JSONArray details = new JSONArray()
                    .put(new JSONObject().put("time", "2026-09-20 12:00:00").put("desc", line))
                    .put(new JSONObject().put("time", "2026-09-20 10:00:00").put("desc", REAL_NODE));
            ExpressQueryResult parcel = ExpressDiscoveryClient.parseExpress(new JSONObject()
                    .put("mailNo", "YT9990000000021").put("cpCode", "YTO").put("name", "圆通速递")
                    .put("provider", "CaiNiao").put("stateNum", 103).put("details", details),
                    "", "13800000001");
            assertNotNull(line, parcel);
            List<ExpressTimeline.Track> nodes = ExpressTimeline.parse(parcel.tracksJson, "", "");
            assertEquals(line, 1, nodes.size());
            assertEquals(line, REAL_NODE, nodes.get(0).detail);
            assertEquals(line, REAL_NODE, parcel.latestDetail);
            assertEquals(line, "2026-09-20 10:00:00", parcel.latestTime);
            assertFalse(line, parcel.tracksJson.contains("运输时效变化"));
        }
        for (String other : new String[]{"您有包裹运输时效变化，请留意取件安排，详情见短信",
                "快件已到达【测试站】 >>"}) {
            assertFalse(other, shared.matcher(other.replaceAll("\\s+", "")).matches());
            assertFalse(other, ExpressStatusNormalizer.isUpdateSummary(other));
            assertFalse(other, ExpressStatusNormalizer.isNonEventDetail(other));
        }
    }

    private static final String[] TRANSIT_TIME_REMINDERS = {
            "您有包裹运输时效变化，请留意取件安排",
            "您有包裹运输时效变化，请留意取件安排 >>",
            "您有包裹运输时效变化，请留意取件安排>>",
            "您有包裹运输时效变化,请留意取件安排 >>",
            "您有包裹运输时效变化,请留意取件安排"};

    private static ExpressQueryResult interface6Row(String headline) throws Exception {
        return ExpressSubscriptionClient.parseExpress(new JSONObject()
                .put("mailNo", "ZTOV6SYNTHETIC").put("cpCode", "ZTO").put("cpName", "中通快递")
                .put("provider", "CaiNiao").put("logsiticsStatus", "1")
                .put("logisticsStatusDesc", "运输中").put("lastLogisticDetail", headline)
                .put("logisticsGmtModified", "2026-09-09 18:00:00"), "", "");
    }

    private static ExpressQueryResult meizuAnswer(String headline, boolean realNode) throws Exception {
        JSONObject answer = new JSONObject().put("nu", "ZTOV6SYNTHETIC").put("com", "ZTO")
                .put("name", "中通快递").put("status", "0").put("stateName", "在途")
                .put("time", "2026-09-20 12:00:00").put("context", headline);
        if (realNode) {
            answer.put("data", new JSONArray().put(new JSONObject()
                    .put("time", "2026-09-20 10:00:00").put("context", REAL_NODE)));
        }
        return ExpressSubscriptionClient.parseManualResponse(
                new JSONObject().put("code", 0).put("data", answer).toString(), "ZTOV6SYNTHETIC");
    }

    private static void assertOnlyTheRealNode(String line, ExpressQueryResult result) {
        assertNotNull(line, result);
        List<ExpressTimeline.Track> nodes = ExpressTimeline.parse(result.tracksJson, "", "");
        assertEquals(line, 1, nodes.size());
        assertEquals(line, REAL_NODE, nodes.get(0).detail);
        assertEquals(line, REAL_NODE, result.latestDetail);
        assertFalse(line, result.tracksJson.contains("快递状态已更新"));
    }
}
