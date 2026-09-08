package me.pipi.deliveries.network;

import me.pipi.deliveries.data.CarrierRegistry;
import me.pipi.deliveries.model.CarrierNormalization;
import me.pipi.deliveries.model.ExpressQueryResult;

import org.json.JSONObject;

/** Reads Worker-owned carrier normalization metadata without reclassifying sync rows locally. */
final class AccountCarrierNormalizer {
    private AccountCarrierNormalizer() {}

    static ExpressQueryResult apply(JSONObject record, ExpressQueryResult result) {
        if (record == null || result == null) return result;
        CarrierNormalization normalization = parse(record);
        return normalization.present()
                ? result.withCarrierNormalization(normalization) : result;
    }

    static CarrierNormalization parse(JSONObject record) {
        if (record == null) return CarrierNormalization.NONE;
        CarrierNormalization current = normalization(record,
                new String[]{"normalizedCarrierCode", "carrierStandardCode"},
                new String[]{"normalizedCarrierName", "carrierDisplayName"},
                new String[]{"normalizedKuaidi100Code", "carrierKuaidi100Code"},
                new String[]{"carrierBuiltIn", "carrierIsBuiltIn"},
                new String[]{"carrierTableVersion", "carrierTableHash"});
        if (current.present()) return validated(current);

        JSONObject nested = record.optJSONObject("carrierNormalization");
        if (nested == null) return CarrierNormalization.NONE;
        return validated(normalization(nested,
                new String[]{"standardCode"}, new String[]{"displayName"},
                new String[]{"kuaidi100Code"}, new String[]{"isBuiltIn", "builtIn"},
                new String[]{"tableVersion"}));
    }

    private static CarrierNormalization normalization(
            JSONObject source, String[] standardKeys, String[] nameKeys,
            String[] kuaidi100Keys, String[] builtInKeys, String[] versionKeys) {
        return new CarrierNormalization(
                first(source, standardKeys), first(source, nameKeys),
                first(source, kuaidi100Keys), optionalBoolean(source, builtInKeys),
                first(source, versionKeys));
    }

    private static CarrierNormalization validated(CarrierNormalization value) {
        if (value == null || !value.present()) return CarrierNormalization.NONE;
        if (Boolean.TRUE.equals(value.builtIn)
                && !CarrierRegistry.matchesBuiltInContract(value)) {
            return CarrierNormalization.NONE;
        }
        return value;
    }

    private static Boolean optionalBoolean(JSONObject object, String... keys) {
        for (String key : keys) {
            if (!object.has(key) || object.isNull(key)) continue;
            Object raw = object.opt(key);
            if (raw instanceof Boolean) return (Boolean) raw;
            String value = String.valueOf(raw).trim();
            if ("true".equalsIgnoreCase(value) || "1".equals(value)) return true;
            if ("false".equalsIgnoreCase(value) || "0".equals(value)) return false;
        }
        return null;
    }

    private static String first(JSONObject object, String... keys) {
        for (String key : keys) {
            String value = object.optString(key, "").trim();
            if (!value.isEmpty() && !"null".equalsIgnoreCase(value)) return value;
        }
        return "";
    }
}
