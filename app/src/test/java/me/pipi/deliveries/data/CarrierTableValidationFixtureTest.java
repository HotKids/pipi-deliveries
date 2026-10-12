package me.pipi.deliveries.data;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import me.pipi.deliveries.BuildConfig;
import me.pipi.deliveries.SharedExpressFixtures;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/**
 * Audits C5 and C12 (user 2026-09-25): one carrier table validation contract with the Worker and
 * Pipi — structure, field types and namespace conflicts, never table content — read from the
 * Worker-generated fixture carrier-table-validation.v1.json, and a bundled startup table that is
 * the served table, not a drifting hand copy.
 */
public final class CarrierTableValidationFixtureTest {
    @Before public void setUp() { CarrierRegistry.resetForTesting(); }
    @After public void tearDown() { CarrierRegistry.resetForTesting(); }

    @Test
    public void everySharedTableCaseIsAcceptedOrRefusedAsTheWorkerDoes() throws Exception {
        JSONObject fixture = SharedExpressFixtures.load("carrier-table-validation.v1.json");
        JSONArray cases = fixture.getJSONArray("cases");
        assertTrue(cases.length() >= 30);
        for (int index = 0; index < cases.length(); index++) {
            JSONObject value = cases.getJSONObject(index);
            JSONObject table = apply(fixture.getJSONObject("base"), value.getJSONArray("operations"));
            String name = value.getString("name");
            if (value.getBoolean("valid")) {
                CarrierRegistry.prepareAuthority(table);
            } else {
                assertThrows(name, IllegalArgumentException.class,
                        () -> CarrierRegistry.prepareAuthority(table));
            }
        }
    }

    /** User decision 2026-09-25: 17 to 256 entries, the Worker's range. */
    @Test
    public void theEntryCountFollowsTheSharedRange() throws Exception {
        JSONObject fixture = SharedExpressFixtures.load("carrier-table-validation.v1.json");
        JSONObject range = fixture.getJSONObject("entryCount");
        JSONObject largest = copy(fixture.getJSONObject("base"));
        JSONArray entries = largest.getJSONArray("entries");
        for (int index = entries.length(); index < range.getInt("max"); index++) {
            entries.put(new JSONObject().put("standardCode", "ZZ" + index)
                    .put("displayName", "测试承运商" + index).put("kuaidi100Code", "zz" + index)
                    .put("hotline", "").put("iconKey", "zz").put("codeAliases", new JSONArray())
                    .put("nameAliases", new JSONArray()).put("requiresPhoneTail", false));
        }
        CarrierRegistry.prepareAuthority(largest);
        entries.put(new JSONObject(entries.getJSONObject(entries.length() - 1).toString())
                .put("standardCode", "ZZOVER").put("kuaidi100Code", "zzover"));
        assertThrows(IllegalArgumentException.class, () -> CarrierRegistry.prepareAuthority(largest));
        assertEquals(17, range.getInt("min"));
        assertEquals(fixture.getJSONObject("base").getJSONArray("entries").length(), range.getInt("min"));
    }

    /** C12: the current build selects its own served table, entry by entry and alias by alias. */
    @Test
    public void theBundledStartupTableIsTheServedTable() throws Exception {
        JSONObject fixture = SharedExpressFixtures.load("carrier-table-validation.v1.json");
        boolean beta = "https://beta.pipiassistant.app".equals(BuildConfig.EXPRESS_GATEWAY_URL);
        JSONObject base = fixture.getJSONObject(beta ? "base" : "formalStartupBase");
        assertEquals(base.getString("version"), CarrierRegistry.AUTHORITY_VERSION);
        assertEquals(base.getString("source"), CarrierRegistry.AUTHORITY_SOURCE);
        assertStartupEntries(base, CarrierRegistry.bootstrapEntriesForTesting());
    }

    @Test
    public void bothStartupSnapshotsExactlyMatchTheirIndependentServedTables() throws Exception {
        JSONObject fixture = SharedExpressFixtures.load("carrier-table-validation.v1.json");
        for (boolean beta : new boolean[]{false, true}) {
            JSONObject base = fixture.getJSONObject(beta ? "base" : "formalStartupBase");
            assertEquals(base.getString("version"), CarrierRegistry.bootstrapVersion(beta));
            assertEquals(base.getString("source"), CarrierRegistry.AUTHORITY_SOURCE);
            assertStartupEntries(base, CarrierRegistry.bootstrapEntriesForTesting(beta));
        }
    }

    private static void assertStartupEntries(JSONObject base, JSONArray bundled) throws Exception {
        JSONArray served = base.getJSONArray("entries");
        assertEquals(served.length(), bundled.length());
        for (int index = 0; index < served.length(); index++) {
            JSONObject expected = served.getJSONObject(index);
            JSONObject actual = bundled.getJSONObject(index);
            assertEquals(expected.getString("standardCode"), canonical(expected), canonical(actual));
        }
    }

    @Test
    public void aFreshBootstrapKeepsThePostalK100AliasInItsApprovedTrackAndNamespace() {
        CarrierRegistry.Carrier alias = CarrierRegistry.resolveKuaidi100Code("youzhengbk");
        assertNotNull(alias);
        assertEquals("YZPY", alias.standardCode);
        assertEquals("youzhengguonei", alias.kuaidi100Code);
        assertNull(CarrierRegistry.resolve("youzhengbk"));
        assertEquals("YZPY", CarrierRegistry.resolveCpCode("YOUZHENGBK").standardCode);
        assertEquals("youzhengguonei", CarrierRegistry.queryCode("YZPY", ""));
        assertEquals("youzhengguonei", CarrierRegistry.queryCode("YOUZHENGBK", ""));
    }

    /** Key order independent; array order and every value exact. */
    private static String canonical(JSONObject entry) throws Exception {
        java.util.TreeMap<String, String> fields = new java.util.TreeMap<>();
        java.util.Iterator<String> keys = entry.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            fields.put(key, String.valueOf(entry.get(key)));
        }
        return fields.toString();
    }

    private static JSONObject apply(JSONObject base, JSONArray operations) throws Exception {
        JSONObject table = copy(base);
        for (int index = 0; index < operations.length(); index++) {
            JSONObject operation = operations.getJSONObject(index);
            boolean delete = operation.has("delete");
            JSONArray path = operation.getJSONArray(delete ? "delete" : "set");
            Object parent = table;
            for (int step = 0; step < path.length() - 1; step++) {
                parent = child(parent, path.get(step));
            }
            Object last = path.get(path.length() - 1);
            if (parent instanceof JSONArray) {
                JSONArray array = (JSONArray) parent;
                int position = ((Number) last).intValue();
                if (delete) array.remove(position);
                else array.put(position, operation.get("value"));
            } else {
                JSONObject object = (JSONObject) parent;
                if (delete) object.remove((String) last);
                else object.put((String) last, operation.get("value"));
            }
        }
        return table;
    }

    private static Object child(Object parent, Object key) throws Exception {
        return parent instanceof JSONArray ? ((JSONArray) parent).get(((Number) key).intValue())
                : ((JSONObject) parent).get((String) key);
    }

    private static JSONObject copy(JSONObject value) throws Exception {
        return new JSONObject(value.toString());
    }
}
