package me.pipi.deliveries.data;

public final class ExpressPhoneBindingPolicy {
    public static final int MAX_BOUND_PHONE_COUNT = 5;

    private ExpressPhoneBindingPolicy() {}

    public static boolean hasCapacity(int currentCount) {
        return currentCount < MAX_BOUND_PHONE_COUNT;
    }

    public static void requireWithinLimit(int phoneCount) {
        if (phoneCount > MAX_BOUND_PHONE_COUNT) {
            throw new IllegalArgumentException(limitMessage());
        }
    }

    public static String limitMessage() {
        return "最多可绑定 " + MAX_BOUND_PHONE_COUNT + " 个手机号";
    }
}
