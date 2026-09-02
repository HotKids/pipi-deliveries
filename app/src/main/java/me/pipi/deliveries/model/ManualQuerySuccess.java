package me.pipi.deliveries.model;

/** One provider package returned by a single manual-query round. */
public class ManualQuerySuccess {
    public final String provider;
    public final ExpressQueryResult result;
    public final long successAt;
    public final boolean complete;

    public ManualQuerySuccess(
            String provider, ExpressQueryResult result, long successAt, boolean complete) {
        this.provider = clean(provider);
        this.result = result;
        this.successAt = successAt;
        this.complete = complete;
    }

    private static String clean(String value) {
        return value == null ? "" : value.trim();
    }
}
