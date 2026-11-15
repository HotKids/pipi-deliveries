package me.pipi.deliveries.util;

/** Locale-invariant lowercase hexadecimal byte encoding without formatter allocations. */
public final class Hex {
    private static final char[] LOWER_DIGITS = {
            '0', '1', '2', '3', '4', '5', '6', '7',
            '8', '9', 'a', 'b', 'c', 'd', 'e', 'f'
    };

    private Hex() {}

    public static String encodeLower(byte[] bytes) {
        if (bytes == null || bytes.length == 0) {
            return "";
        }
        return encodeLower(bytes, 0, bytes.length);
    }

    public static String encodeLower(byte[] bytes, int offset, int length) {
        if (bytes == null) {
            return "";
        }
        if (offset < 0 || length < 0 || offset > bytes.length - length) {
            throw new IndexOutOfBoundsException(
                    "offset=" + offset + ", length=" + length + ", size=" + bytes.length);
        }
        if (length == 0) {
            return "";
        }
        char[] out = new char[length * 2];
        for (int index = 0; index < length; index++) {
            int value = bytes[offset + index] & 0xff;
            out[index * 2] = LOWER_DIGITS[value >>> 4];
            out[index * 2 + 1] = LOWER_DIGITS[value & 0x0f];
        }
        return new String(out);
    }
}
