package me.pipi.deliveries.network;

import android.annotation.SuppressLint;
import android.content.Context;
import android.content.SharedPreferences;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.security.SecureRandom;
import java.util.Enumeration;

/** Stable per-install device namespace used by the subscription endpoint. */
public final class DeviceIdentity {
    private static final String PREFS = "aicy_imei";
    private static final String KEY_IMEI = "imei";
    private static final SecureRandom RANDOM = new SecureRandom();

    private DeviceIdentity() {}

    @SuppressLint("ApplySharedPref")
    public static synchronized String imei(Context context) {
        SharedPreferences prefs = context.getApplicationContext()
                .getSharedPreferences(PREFS, 0);
        String existing = prefs.getString(KEY_IMEI, "");
        if (validImei(existing)) return existing;
        String generated = generateImei();
        if (!prefs.edit().putString(KEY_IMEI, generated).commit()) {
            throw new IllegalStateException("无法保存设备标识，请稍后重试");
        }
        return generated;
    }

    /** Matches the final pre-refactor app: 14 random digits plus an IMEI Luhn check digit. */
    static String generateImei() {
        StringBuilder value = new StringBuilder(15);
        int sum = 0;
        for (int index = 0; index < 14; index++) {
            int digit = RANDOM.nextInt(10);
            value.append(digit);
            int contribution = digit;
            if ((index & 1) == 1) {
                contribution *= 2;
                if (contribution > 9) contribution -= 9;
            }
            sum += contribution;
        }
        value.append((10 - sum % 10) % 10);
        return value.toString();
    }

    static boolean validImei(String value) {
        if (value == null || !value.matches("\\d{15}")) return false;
        int sum = 0;
        for (int index = 0; index < value.length(); index++) {
            int digit = value.charAt(index) - '0';
            if (index < 14 && (index & 1) == 1) {
                digit *= 2;
                if (digit > 9) digit -= 9;
            }
            sum += digit;
        }
        return sum % 10 == 0;
    }

    /** Local IPv4 parameter used by the subscription request. */
    static String clientIp() {
        try {
            Enumeration<NetworkInterface> interfaces = NetworkInterface.getNetworkInterfaces();
            while (interfaces != null && interfaces.hasMoreElements()) {
                NetworkInterface network = interfaces.nextElement();
                if (!network.isUp() || network.isLoopback()) continue;
                Enumeration<InetAddress> addresses = network.getInetAddresses();
                while (addresses.hasMoreElements()) {
                    InetAddress address = addresses.nextElement();
                    if (address instanceof Inet4Address && !address.isLoopbackAddress()) {
                        return address.getHostAddress();
                    }
                }
            }
        } catch (Throwable ignored) {
            // The original client also falls back to an empty clientip when it cannot resolve one.
        }
        return "";
    }
}
