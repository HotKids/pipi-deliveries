package me.pipi.deliveries.network;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import me.pipi.deliveries.SharedExpressFixtures;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

/**
 * Audit L6 (user 2026-09-25): which interface-5 row is a JD order is decided once, by the Worker's
 * scope; the local rule is only for rows stored before a Worker projection existed, and it matches
 * the Worker's rule on every shared case (order-scope-cases.v1.json; the v3 cases are Pipi's).
 */
public final class OrderScopeFixtureTest {
    @Test
    public void theLocalRuleMatchesTheWorkerOnEverySharedInterface5Case() throws Exception {
        JSONArray cases = SharedExpressFixtures.load("order-scope-cases.v1.json").getJSONArray("cases");
        int checked = 0;
        for (int index = 0; index < cases.length(); index++) {
            JSONObject value = cases.getJSONObject(index);
            if (!"v5".equals(value.getString("interface"))) continue;
            checked++;
            JSONObject row = value.getJSONObject("row");
            boolean order = "ORDER".equals(value.getJSONObject("expected").getString("scope"));
            assertEquals(value.getString("provenance"), order,
                    ExpressDiscoveryClient.isAccountOrderRecord(row));
        }
        assertTrue(checked >= 10);
    }

    @Test
    public void theWorkersScopeDecidesWhenItIsThere() throws Exception {
        JSONArray cases = SharedExpressFixtures.load("order-scope-cases.v1.json").getJSONArray("cases");
        for (int index = 0; index < cases.length(); index++) {
            JSONObject value = cases.getJSONObject(index);
            if (!"v5".equals(value.getString("interface"))) continue;
            String expected = value.getJSONObject("expected").getString("scope");
            String opposite = "ORDER".equals(expected) ? "SHIPMENT" : "ORDER";
            JSONObject flat = new JSONObject(value.getJSONObject("row").toString())
                    .put("normalizedStatusScope", opposite);
            assertEquals(value.getString("provenance"), "ORDER".equals(opposite),
                    ExpressDiscoveryClient.isAccountOrderRecord(flat));
            JSONObject nested = new JSONObject(value.getJSONObject("row").toString())
                    .put("normalizedStatus", new JSONObject().put("version", 1).put("scope", opposite)
                            .put("semantic", "TRANSIT").put("code", "104").put("text", "运输中")
                            .put("priority", 0).put("eventAtMs", 1L).put("structured", true));
            assertEquals(value.getString("provenance"), "ORDER".equals(opposite),
                    ExpressDiscoveryClient.isAccountOrderRecord(nested));
        }
        assertFalse("an unknown scope value falls back to the local rule",
                ExpressDiscoveryClient.isAccountOrderRecord(new JSONObject()
                        .put("mailNo", "JT4006839564547").put("provider", "JingDong")
                        .put("normalizedStatusScope", "PARCEL")));
    }
}
