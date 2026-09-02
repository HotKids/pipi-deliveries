package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import me.pipi.deliveries.model.ExpressItem;
import me.pipi.deliveries.model.ExpressQueryResult;
import me.pipi.deliveries.model.StatusSemantic;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.Arrays;

public final class ExpressDiscoveryClientTest {
    @Test
    public void receiverAndSenderPhonesAreIndependentOwnershipEvidence() throws Exception {
        JSONObject sentParcel = new JSONObject()
                .put("phone", "****1111")
                .put("sendPhone", "13800138000");
        JSONObject maskedSender = new JSONObject()
                .put("phone", "****1111")
                .put("sendPhone", "138****8000");
        JSONObject receivedParcel = new JSONObject()
                .put("phone", "138****8000")
                .put("sendPhone", "****1111");
        JSONObject fullReceiver = new JSONObject()
                .put("phone", "+86 13800138000")
                .put("sendPhone", "****1111");

        assertEquals("13800138000", ExpressDiscoveryClient.matchedPhone(
                sentParcel, Arrays.asList("13900002222", "13800138000"), true));
        assertEquals("13800138000", ExpressDiscoveryClient.matchedPhone(
                maskedSender, Arrays.asList("13900002222", "13800138000"), true));
        assertEquals("13800138000", ExpressDiscoveryClient.matchedPhone(
                receivedParcel, Arrays.asList("13900002222", "13800138000"), true));
        assertEquals("13800138000", ExpressDiscoveryClient.matchedPhone(
                fullReceiver, Arrays.asList("13900002222", "13800138000"), true));
    }

    @Test
    public void conflictingOrUnmatchedPhoneEvidenceNeverUsesSingleBindingFallback()
            throws Exception {
        JSONObject conflicting = new JSONObject()
                .put("phone", "13800138000")
                .put("sendPhone", "13900139000");
        JSONObject otherPhone = new JSONObject().put("phone", "****1111");
        JSONObject fullNumberWithSameTail = new JSONObject()
                .put("phone", "13999998000");
        JSONObject ambiguousMaskedPhone = new JSONObject()
                .put("phone", "****8000");

        assertEquals("", ExpressDiscoveryClient.matchedPhone(
                conflicting, Arrays.asList("13800138000", "13900139000"), true));
        assertEquals("", ExpressDiscoveryClient.matchedPhone(
                otherPhone, Arrays.asList("13800138000"), true));
        assertEquals("", ExpressDiscoveryClient.matchedPhone(
                fullNumberWithSameTail, Arrays.asList("13800138000"), true));
        assertEquals("", ExpressDiscoveryClient.matchedPhone(
                ambiguousMaskedPhone,
                Arrays.asList("13900008000", "13800138000"), true));
    }

    @Test
    public void singleBindingFallbackRequiresNoUsablePhoneEvidence() {
        assertEquals("13800138000", ExpressDiscoveryClient.matchedPhone(
                new JSONObject(), Arrays.asList("13800138000"), true));
        assertEquals("", ExpressDiscoveryClient.matchedPhone(
                new JSONObject(), Arrays.asList("13800138000"), false));
    }

    @Test
    public void officialStateNumbersCoverTheCompleteAccountContract() {
        String[] values = {
                "101", "102", "103", "104", "105", "106", "107",
                "108", "109", "110", "111"
        };
        StatusSemantic[] expected = {
                StatusSemantic.ORDERED, StatusSemantic.SHIPPED,
                StatusSemantic.PICKED, StatusSemantic.TRANSIT,
                StatusSemantic.DELIVERY, StatusSemantic.WAITING_PICKUP,
                StatusSemantic.COMPLETED, StatusSemantic.DANGER,
                StatusSemantic.DANGER, StatusSemantic.DANGER,
                StatusSemantic.CANCELLED
        };
        for (int index = 0; index < values.length; index++) {
            assertEquals(expected[index], StatusSemantic.fromAccountState(values[index], ""));
        }
        assertEquals(StatusSemantic.WAITING_PICKUP,
                StatusSemantic.fromAccountState("", "待取件"));
    }

    @Test
    public void v5StandardH5BuildsOnlyAnInternalPersistedMarker() throws Exception {
        String route = "https://page.cainiao.com/guoguo/app-myexpress-taobao/ld.html"
                + "?mailNo=79000000000001&cpCode=ZTO&secretKey=-123456789&from="
                + "INTERFACE5";
        JSONObject item = new JSONObject().put("detailUrl", route);

        assertEquals("pipi-route:v5",
                ExpressDiscoveryClient.cainiaoUrl(item, "79000000000001", "ZTO"));
        assertEquals(route, ExpressDiscoveryClient.cainiaoDetailUrl(item));
    }

    @Test
    public void missingSecretDoesNotBuildBrokenGenericLink() {
        assertEquals("", ExpressDiscoveryClient.cainiaoUrl(
                new JSONObject(), "79000000000001", "ZTO"));
    }

    @Test
    public void cainiaoPlaceholderKeepsStateOutOfLatestEvent() throws Exception {
        JSONObject item = new JSONObject()
                .put("mailNo", "79000000000001")
                .put("cpCode", "ZTO")
                .put("name", "中通快递")
                .put("provider", "CaiNiao")
                .put("state", "代取件")
                .put("stateNum", 106)
                .put("details", new JSONArray().put(new JSONObject()
                        .put("time", "2026-08-15 16:55:25")
                        .put("desc", "快递状态已更新，点击查看>>")));

        ExpressQueryResult parsed = ExpressDiscoveryClient.parseExpress(
                item.put("detailUrl", "https://page.cainiao.com/guoguo/"
                        + "app-myexpress-taobao/ld.html?mailNo=79000000000001"
                        + "&cpCode=ZTO&secretKey=one&from="
                        + "INTERFACE5"), "pipi-route:v5", "13800138000");

        assertNotNull(parsed);
        assertEquals(StatusSemantic.WAITING_PICKUP, parsed.semantic);
        assertEquals("", parsed.latestDetail);
        assertEquals("", parsed.latestTime);
        assertEquals("[]", parsed.tracksJson);
        assertEquals("13800138000", parsed.phone);
        assertEquals("v5", parsed.routeInterface);
        assertEquals(item.getString("detailUrl"), parsed.routeCredential);
    }

    @Test
    public void fullSingleParcelResponseSuppliesTheMissingHeadline() throws Exception {
        JSONObject item = new JSONObject()
                .put("mailNo", "SF0000000000001")
                .put("cpCode", "SF")
                .put("name", "顺丰速运")
                .put("provider", "CaiNiao")
                .put("state", "已签收")
                .put("stateNum", 107)
                .put("details", new JSONArray()
                        .put(new JSONObject()
                                .put("time", "2026-08-14 11:59:49")
                                .put("desc", "在顺丰官网可查看收件信息"))
                        .put(new JSONObject()
                                .put("time", "2026-08-14 10:45:22")
                                .put("desc", "快件正在派送途中")));

        ExpressQueryResult parsed = ExpressDiscoveryClient.parseExpress(
                item.put("detailUrl", "https://page.cainiao.com/guoguo/"
                        + "app-myexpress-taobao/ld.html?mailNo=SF0000000000001"
                        + "&cpCode=SF&secretKey=one&from="
                        + "INTERFACE5"), "pipi-route:v5", "");

        assertNotNull(parsed);
        assertEquals(StatusSemantic.COMPLETED, parsed.semantic);
        assertEquals("在顺丰官网可查看收件信息", parsed.latestDetail);
        assertEquals("2026-08-14 11:59:49", parsed.latestTime);
        assertEquals(2, new JSONArray(parsed.tracksJson).length());
    }

    @Test
    public void sourceProviderSurvivesParsingAndKnownItemSummaryReconstruction()
            throws Exception {
        JSONObject raw = new JSONObject()
                .put("mailNo", "SF0000000000002")
                .put("cpCode", "SF")
                .put("name", "顺丰速运")
                .put("provider", "ShunFeng")
                .put("stateNum", 104)
                .put("details", new JSONArray().put(new JSONObject()
                        .put("time", "2026-08-24 10:00:00")
                        .put("desc", "快件运输中")));

        ExpressQueryResult parsed = ExpressDiscoveryClient.parseExpress(raw, "", "");
        ExpressItem persisted = new ExpressItem(
                1L, "13800138000", parsed.waybill, parsed.courierCode,
                parsed.companyName, parsed.semantic, parsed.semantic.label,
                parsed.latestDetail, parsed.latestTime, parsed.tracksJson, "",
                "INTERFACE5", "", 1L, 2L, "INTERFACE5", "", "", "", true,
                "", "", "", parsed.sourceProvider);

        assertEquals("ShunFeng", parsed.sourceProvider);
        assertEquals("ShunFeng",
                ExpressDiscoveryClient.itemSummary(persisted).getString("provider"));
    }

    @Test
    public void sourceProviderUsesProviderNameFallbackWithoutSyntheticDefaults()
            throws Exception {
        JSONObject fallback = new JSONObject()
                .put("mailNo", "SF0000000000003")
                .put("cpCode", "SF")
                .put("name", "顺丰速运")
                .put("providerName", "ShunFeng")
                .put("stateNum", 104)
                .put("details", new JSONArray().put(new JSONObject()
                        .put("time", "2026-08-24 10:00:00")
                        .put("desc", "快件运输中")));
        ExpressQueryResult parsed = ExpressDiscoveryClient.parseExpress(fallback, "", "");
        assertNotNull(parsed);
        assertEquals("ShunFeng", parsed.sourceProvider);

        ExpressItem unknown = new ExpressItem(
                2L, "", "UNKNOWN123456", "SF", "顺丰速运",
                StatusSemantic.TRANSIT, "运输中", "账号来源摘要",
                "2026-08-24 10:00:00", "[]", "", "INTERFACE5", "",
                1L, 2L, "INTERFACE5", "", "", "", true,
                "", "", "[]", "");
        assertEquals("", ExpressDiscoveryClient.itemSummary(unknown).getString("provider"));
    }

    @Test
    public void completeDetailWinsWhenAnEmptySummaryComesFirst() throws Exception {
        JSONObject emptySummary = new JSONObject()
                .put("mailNo", "TEST123456")
                .put("details", new JSONArray());
        JSONObject complete = new JSONObject()
                .put("mailNo", "TEST123456")
                .put("details", new JSONArray().put(new JSONObject()
                        .put("time", "2026-08-22 12:00:00")
                        .put("desc", "快件运输中")));
        JSONArray response = new JSONArray()
                .put(emptySummary)
                .put(new JSONObject().put("encoded", complete.toString()));

        JSONObject selected = ExpressDiscoveryClient.findDetailObject(response);

        assertNotNull(selected);
        assertEquals(1, selected.getJSONArray("details").length());
        assertEquals("快件运输中",
                selected.getJSONArray("details").getJSONObject(0).getString("desc"));
    }

    @Test
    public void completeDetailWinsWhenAPlaceholderSummaryComesFirst() throws Exception {
        JSONObject placeholder = new JSONObject()
                .put("mailNo", "TEST123456")
                .put("details", new JSONArray().put(new JSONObject()
                        .put("time", "2026-08-22 12:10:00")
                        .put("desc", "快递状态已更新，点击查看>>")));
        JSONObject complete = new JSONObject()
                .put("mailNo", "TEST123456")
                .put("details", new JSONArray()
                        .put(new JSONObject()
                                .put("time", "2026-08-22 12:00:00")
                                .put("desc", "快件运输中"))
                        .put(new JSONObject()
                                .put("time", "2026-08-22 11:00:00")
                                .put("desc", "快件已揽收")));

        JSONObject selected = ExpressDiscoveryClient.findDetailObject(
                new JSONArray().put(placeholder).put(complete.toString()));

        assertNotNull(selected);
        assertEquals(2, selected.getJSONArray("details").length());
    }

    @Test
    public void observedNumericStateStillWorksWhenProviderOmitsStateText() throws Exception {
        JSONObject item = new JSONObject()
                .put("mailNo", "79000000000002")
                .put("cpCode", "ZTO")
                .put("name", "中通快递")
                .put("provider", "CaiNiao")
                .put("stateNum", 104);

        assertEquals(StatusSemantic.TRANSIT,
                ExpressDiscoveryClient.parseExpress(item, "route", "").semantic);
    }

    @Test
    public void nonOrderRowsRemainAccountPrimaryData() throws Exception {
        JSONObject item = new JSONObject()
                .put("mailNo", "OTHER001")
                .put("provider", "Other")
                .put("state", "运输中");

        assertEquals(StatusSemantic.TRANSIT,
                ExpressDiscoveryClient.parseExpress(item, "", "").semantic);
    }

    @Test
    public void jdOrderCachesEveryRealAccountTrackWithoutPretendingItIsAWaybill()
            throws Exception {
        JSONObject item = new JSONObject()
                .put("mailNo", "1234567890123456")
                .put("cpCode", "JD")
                .put("name", "京东物流")
                .put("provider", "JingDong")
                .put("state", "运输中")
                .put("details", new JSONArray()
                        .put(new JSONObject()
                                .put("time", "2026-08-16 10:00:00")
                                .put("desc", "运输中"))
                        .put(new JSONObject()
                                .put("time", "2026-08-16 09:30:00")
                                .put("desc", "货物已到达京东深圳分拨中心"))
                        .put(new JSONObject()
                                .put("time", "2026-08-16 08:00:00")
                                .put("desc", "快递状态已更新，点击查看>>")));

        ExpressQueryResult parsed = ExpressDiscoveryClient.parseAccountOrder(item);

        assertNotNull(parsed);
        assertEquals("1234567890123456", parsed.waybill);
        assertEquals("JD", parsed.courierCode);
        assertEquals("京东物流", parsed.companyName);
        assertEquals("JingDong", parsed.sourceProvider);
        assertEquals(StatusSemantic.TRANSIT, parsed.semantic);
        assertEquals("货物已到达京东深圳分拨中心", parsed.latestDetail);
        assertEquals(1, new JSONArray(parsed.tracksJson).length());
    }

    @Test
    public void jdOrderRequiresExactProviderAndSixteenDigitMailNumber() throws Exception {
        JSONObject canonicalOrder = new JSONObject()
                .put("mailNo", "1234567890123456")
                .put("cpCode", "JD")
                .put("provider", "JingDong");
        JSONObject providerNameFallback = new JSONObject()
                .put("mailNo", "1234567890123457")
                .put("providerName", "JingDong");
        JSONObject nonEmptyProviderWins = new JSONObject()
                .put("mailNo", "1234567890123458")
                .put("provider", "CaiNiao")
                .put("providerName", "JingDong");
        JSONObject jdWaybill = new JSONObject()
                .put("mailNo", "JDAP123456789012")
                .put("cpCode", "JD")
                .put("name", "京东快递")
                .put("provider", "JingDong")
                .put("stateNum", 104);
        JSONObject jdCodeOnly = new JSONObject()
                .put("mailNo", "1234567890123459")
                .put("cpCode", "JD");

        assertTrue(ExpressDiscoveryClient.isAccountOrderRecord(canonicalOrder));
        assertTrue(ExpressDiscoveryClient.isAccountOrderRecord(providerNameFallback));
        assertFalse(ExpressDiscoveryClient.isAccountOrderRecord(nonEmptyProviderWins));
        assertFalse(ExpressDiscoveryClient.isAccountOrderRecord(jdWaybill));
        assertFalse(ExpressDiscoveryClient.isAccountOrderRecord(jdCodeOnly));
        assertEquals("京东快递",
                ExpressDiscoveryClient.parseExpress(jdWaybill, "", "").companyName);
    }

    @Test
    public void accountOrderKeepsItsOwnRawH5ForTheIsolatedProjectionPage()
            throws Exception {
        String h5 = "https://u.jd.com/forward?token=opaque";
        JSONObject item = new JSONObject()
                .put("mailNo", "1234567890123456")
                .put("cpCode", "JD")
                .put("provider", "JingDong")
                .put("stateNum", 104)
                .put("jumpList", new JSONArray()
                        .put(new JSONObject().put("type", "app").put("link", "scheme://app"))
                        .put(new JSONObject().put("type", "h5").put("link", h5)));

        ExpressQueryResult parsed = ExpressDiscoveryClient.parseAccountOrder(item);

        assertNotNull(parsed);
        assertEquals(h5, ExpressDiscoveryClient.accountOrderH5Url(item));
        assertEquals("pipi-route:v5", parsed.detailUrl);
        assertEquals("v5", parsed.routeInterface);
        assertEquals(h5, parsed.routeCredential);
    }

    @Test
    public void jdDetailQueryCarriesTheCompleteSingleParcelContract() throws Exception {
        JSONObject summary = new JSONObject()
                .put("orderNo", "JDORDER00000001")
                .put("cpCode", "JD")
                .put("name", "京东物流")
                .put("provider", "JingDong")
                .put("stateNum", 104)
                .put("details", new JSONArray().put(new JSONObject()
                        .put("time", "2026-08-16 10:00:00")
                        .put("desc", "货物运输中")));

        JSONObject info = ExpressDiscoveryClient.detailRecord(summary, "13800138000");

        assertEquals("JDORDER00000001", info.getString("waybill"));
        assertEquals("JD", info.getString("companyCode"));
        assertEquals("JingDong", info.getString("provider"));
        assertEquals("13800138000", info.getString("phone"));
        assertEquals("2026-08-16 10:00:00",
                info.getString("updateTime"));
        assertEquals(104, info.getInt("stateNumber"));
    }

    @Test
    public void detailQueryUsesTheMatchedSourcePhoneInsteadOfTheRawReceiverField()
            throws Exception {
        JSONObject summary = new JSONObject()
                .put("mailNo", "SFTEST000001")
                .put("cpCode", "SF")
                .put("name", "顺丰速运")
                .put("phone", "****5678")
                .put("sendPhone", "****8000");

        String matched = ExpressDiscoveryClient.matchedPhone(
                summary, Arrays.asList("13800138000"), true);
        JSONObject record = ExpressDiscoveryClient.detailRecord(summary, matched);

        assertEquals("13800138000", matched);
        assertEquals("13800138000", record.getString("phone"));
        assertEquals(Arrays.asList("8000"), ExpressApi.phoneTails(Arrays.asList(matched)));
    }

    @Test
    public void detailQueryUsesProviderNameOnlyWhenProviderIsAbsent() throws Exception {
        JSONObject summary = new JSONObject()
                .put("mailNo", "SFTEST000003")
                .put("cpCode", "SF")
                .put("name", "顺丰速运")
                .put("providerName", "ShunFeng");
        JSONObject conflicting = new JSONObject()
                .put("mailNo", "TEST000004")
                .put("provider", "CaiNiao")
                .put("providerName", "ShunFeng");

        assertEquals("ShunFeng",
                ExpressDiscoveryClient.detailRecord(summary, "").getString("provider"));
        assertEquals("CaiNiao",
                ExpressDiscoveryClient.detailRecord(conflicting, "").getString("provider"));
    }

    @Test
    public void detailQueryKeepsACompleteRawPhoneWithoutAMatchedFallback()
            throws Exception {
        JSONObject summary = new JSONObject()
                .put("mailNo", "SFTEST000002")
                .put("cpCode", "SF")
                .put("phone", "13900139000");

        JSONObject record = ExpressDiscoveryClient.detailRecord(summary, "");

        assertEquals("13900139000", record.getString("phone"));
    }

    @Test
    public void knownJdOrderCanBeRefreshedWithoutAnotherListDiscovery() throws Exception {
        ExpressItem item = new ExpressItem(
                1L, "13800138000", "JDORDER00000001", "JD", "京东购物",
                StatusSemantic.PICKED, "揽件", "", "2026-08-20 16:36:00",
                "[]", "", "I5-JD", "", 1L, 2L, "I5-JD", "", "", "", true,
                "", "", "", "JingDong");

        JSONObject summary = ExpressDiscoveryClient.accountOrderSummary(item);
        JSONObject record = ExpressDiscoveryClient.detailRecord(summary, item.phone);

        assertEquals("JDORDER00000001", record.getString("waybill"));
        assertEquals("JD", record.getString("companyCode"));
        assertEquals("JingDong", record.getString("provider"));
        assertEquals(103, record.getInt("stateNumber"));
        assertEquals("13800138000", record.getString("phone"));
    }

    @Test
    public void unprojectedOrderPresentationDoesNotRewriteRefreshState() throws Exception {
        ExpressItem item = new ExpressItem(
                1L, "13800138000", "JDORDER00000001", "JD", "京东购物",
                StatusSemantic.ORDERED, "已揽件", "", "2026-08-20 16:36:00",
                "[]", "", "I5-JD", "", 1L, 2L, "I5-JD", "", "", "", true,
                "", "", "", "JingDong", false, "", 0L, StatusSemantic.PICKED);

        JSONObject summary = ExpressDiscoveryClient.accountOrderSummary(item);

        assertEquals("已揽件", summary.getString("state"));
        assertEquals(103, summary.getInt("stateNum"));
        assertEquals("已下单", item.displayStatus());
    }

    @Test
    public void terminalJdWithoutTracksRetriesOnChangeOrSixHourExpiry() {
        long now = 2_000_000_000L;
        long hour = 60L * 60L * 1000L;
        assertTrue(ExpressDiscoveryClient.shouldRefreshKnownOrder(
                StatusSemantic.TRANSIT, "current", "current", now, now));
        assertTrue(ExpressDiscoveryClient.shouldRefreshKnownOrder(
                StatusSemantic.COMPLETED, "current", "current", 0L, now));
        assertTrue(ExpressDiscoveryClient.shouldRefreshKnownOrder(
                StatusSemantic.COMPLETED, "current", "previous", now, now));
        assertFalse(ExpressDiscoveryClient.shouldRefreshKnownOrder(
                StatusSemantic.COMPLETED, "current", "current", now - 5L * hour, now));
        assertTrue(ExpressDiscoveryClient.shouldRefreshKnownOrder(
                StatusSemantic.COMPLETED, "current", "current", now - 6L * hour, now));
        assertTrue(ExpressDiscoveryClient.shouldRefreshKnownOrder(
                StatusSemantic.COMPLETED, "current", "current", now + 1L, now));
    }

    @Test
    public void detailOverlayCannotReplaceTheRequestedShipmentIdentity() throws Exception {
        JSONObject summary = new JSONObject()
                .put("orderNo", "ORDER-A")
                .put("mailNo", "WAYBILL-A")
                .put("provider", "ShunFeng")
                .put("state", "运输中");
        JSONObject detail = new JSONObject()
                .put("orderNo", "ORDER-B")
                .put("mailNo", "WAYBILL-B")
                .put("provider", "CaiNiao")
                .put("details", new JSONArray().put(new JSONObject()
                        .put("time", "2026-08-22 12:00:00")
                        .put("desc", "已到达转运中心")));

        JSONObject merged = ExpressDiscoveryClient.overlay(summary, detail);

        assertEquals("ORDER-A", merged.getString("orderNo"));
        assertEquals("WAYBILL-A", merged.getString("mailNo"));
        assertEquals("ShunFeng", merged.getString("provider"));
        assertEquals(1, merged.getJSONArray("details").length());
    }

    @Test
    public void knownRefreshCannotTurnASyntheticProviderIntoRawOwnershipEvidence() {
        ExpressQueryResult parsed = new ExpressQueryResult(
                "WAYBILL-A", "SF", "顺丰速运", StatusSemantic.TRANSIT,
                "2026-08-24 10:00:00", "快件运输中",
                "[{\"time\":\"2026-08-24 10:00:00\","
                        + "\"context\":\"快件运输中\"}]",
                "", "", "interface5", "", "", "CaiNiao");

        ExpressQueryResult restored =
                ExpressDiscoveryClient.withSourceProvider(parsed, "");

        assertEquals("", restored.sourceProvider);
        assertEquals(parsed.tracksJson, restored.tracksJson);
        assertEquals(parsed.timelineProvider, restored.timelineProvider);
    }

    @Test
    public void detailIdentityMustBeAbsentOrCausallyMatchTheRequest() throws Exception {
        assertTrue(ExpressDiscoveryClient.detailMatchesRequestedIdentity(
                new JSONObject().put("details", new JSONArray()), "ORDER-A"));
        assertTrue(ExpressDiscoveryClient.detailMatchesRequestedIdentity(
                new JSONObject().put("mailNo", JSONObject.NULL).put("orderNo", "null"),
                "ORDER-A"));
        assertTrue(ExpressDiscoveryClient.detailMatchesRequestedIdentity(
                new JSONObject().put("mailNo", "WAYBILL-A").put("orderNo", "ORDER-A"),
                "ORDER-A"));
        assertFalse(ExpressDiscoveryClient.detailMatchesRequestedIdentity(
                new JSONObject().put("mailNo", "WAYBILL-B"), "WAYBILL-A"));
    }

    @Test
    public void detailCandidateDeduplicationPreservesDifferentOwnershipEvidence() throws Exception {
        JSONObject first = new JSONObject()
                .put("mailNo", "WAYBILL-A")
                .put("state", "运输中")
                .put("phone", "138****0000");
        JSONObject duplicate = new JSONObject(first.toString());
        JSONObject differentPhone = new JSONObject(first.toString())
                .put("phone", "139****1111");

        assertEquals(
                ExpressDiscoveryClient.detailCandidateKey(first),
                ExpressDiscoveryClient.detailCandidateKey(duplicate));
        assertNotEquals(
                ExpressDiscoveryClient.detailCandidateKey(first),
                ExpressDiscoveryClient.detailCandidateKey(differentPhone));
    }

    @Test
    public void detailCacheRetentionExpiresOldAndFutureClockEntries() {
        long now = 2_000_000_000L;
        assertTrue(ExpressDiscoveryClient.retainDetailCache(now - 1L, now));
        assertFalse(ExpressDiscoveryClient.retainDetailCache(0L, now));
        assertFalse(ExpressDiscoveryClient.retainDetailCache(now + 1L, now));
        assertFalse(ExpressDiscoveryClient.retainDetailCache(
                now - 8L * 24L * 60L * 60L * 1000L, now));
    }

    @Test
    public void missingLocalRowAlwaysRefreshesDespiteAnOldMatchingSignature() {
        long now = 2_000_000_000L;
        assertTrue(ExpressDiscoveryClient.shouldQueryDetails(
                "unchanged", "unchanged", null, now - 1L, now));
    }

    @Test
    public void accountSyncNormalizesAndLimitsPhones() {
        assertEquals(2, ExpressDiscoveryClient.normalizedPhones(
                java.util.Arrays.asList("138 0013 8000", "13900139000")).size());
        assertEquals(5, ExpressDiscoveryClient.normalizedPhones(java.util.Arrays.asList(
                "13800138000", "13900139000", "13700137000",
                "13600136000", "13500135000")).size());
        IllegalArgumentException failure = null;
        try {
            ExpressDiscoveryClient.normalizedPhones(java.util.Arrays.asList(
                    "13800138000", "13900139000", "13700137000",
                    "13600136000", "13500135000", "13400134000"));
        } catch (IllegalArgumentException expected) {
            failure = expected;
        }
        assertNotNull(failure);
        assertEquals("最多可绑定 5 个手机号", failure.getMessage());
    }
}
