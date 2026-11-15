package me.pipi.deliveries.util;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

public final class HexAndStringsTest {
    @Test
    public void encodeLowerEncodesFullAndPrefixByteSlicesWithoutLocaleFormatting() {
        byte[] sample = new byte[]{0x00, 0x0f, (byte) 0xa5, (byte) 0xff};
        assertEquals("", Hex.encodeLower(null));
        assertEquals("", Hex.encodeLower(new byte[0]));
        assertEquals("000fa5ff", Hex.encodeLower(sample));
        assertEquals("0fa5", Hex.encodeLower(sample, 1, 2));
        assertEquals("", Hex.encodeLower(sample, 2, 0));
    }

    @Test
    public void stringsCleanHandlesNullJsonNullAndWhitespace() {
        assertEquals("", Strings.clean((String) null));
        assertEquals("", Strings.clean((Object) null));
        assertEquals("", Strings.clean(JSONObject.NULL));
        assertEquals("SF123", Strings.clean("  SF123 \n"));
        assertTrue(Strings.isBlank("   "));
        assertFalse(Strings.isBlank(" ok "));
    }
}
