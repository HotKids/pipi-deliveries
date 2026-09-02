package me.pipi.deliveries.widget;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.zip.InflaterInputStream;

/** Guards the separate Android 12 standard and Android 10 compatibility artifacts. */
public final class ExpressCompatibilityContractTest {
    @Test
    public void flavorsKeepTheStandardFloorAndAddApi29Compatibility() throws Exception {
        String gradle = projectFile("app/build.gradle.kts");
        assertTrue(gradle.contains("create(\"standard\")"));
        assertTrue(gradle.contains("create(\"compat\")"));
        assertTrue(gradle.contains("minSdk = 31"));
        assertTrue(gradle.contains("minSdk = 29"));
    }

    @Test
    public void api31KeepsOnlyTheLayoutMutationNeededByStaticRows() throws Exception {
        String provider = source("ExpressWidgetProvider.java");
        String api31 = source("ExpressWidgetApi31.java");
        String manifest = projectFile("app/src/main/AndroidManifest.xml");

        assertFalse(provider.contains("RemoteViews.RemoteCollectionItems"));
        assertFalse(provider.contains("setViewLayoutHeight"));
        assertTrue(api31.contains("setViewLayoutHeight"));
        assertTrue(api31.contains("applyWideRowHeight"));
        assertFalse(api31.contains("RemoteViews.RemoteCollectionItems"));
        assertFalse(manifest.contains("ExpressWidgetLegacyService"));
        assertTrue(provider.contains("ExpressWidgetRowPolicy.calculate("));
        assertTrue(provider.contains("typography.lineBox("));
    }

    @Test
    public void wideCardUsesPipiStaticRowsWithOnlyTheStatusCapsuleAdded() throws Exception {
        String layout = projectFile("app/src/main/res/layout/express_widget_4x2.xml");
        String styles = projectFile("app/src/main/res/values/styles.xml");
        String provider = source("ExpressWidgetProvider.java");

        assertFalse(layout.contains("ListView"));
        assertEquals(1, occurrences(layout, "@+id/widget_express_row1"));
        assertEquals(1, occurrences(layout, "@+id/widget_express_row2"));
        assertEquals(1, occurrences(layout, "@+id/widget_express_row3"));
        assertEquals(3, occurrences(layout, "@style/DeliveriesExpressWideLogo"));
        assertTrue(styles.contains("<item name=\"android:layout_width\">40dp</item>"));
        assertTrue(styles.contains("<item name=\"android:layout_marginStart\">12dp</item>"));
        assertTrue(styles.contains("<item name=\"android:textSize\">16sp</item>"));
        assertTrue(styles.contains("<item name=\"android:textSize\">13sp</item>"));
        assertTrue(styles.contains("<item name=\"android:layout_height\">18dp</item>"));
        assertTrue(styles.contains("<item name=\"android:textSize\">11dp</item>"));
        assertTrue(provider.contains("bindWideRow("));
        assertTrue(provider.contains("setBackgroundResource"));
        assertTrue(provider.contains("setImageViewResource"));
    }

    @Test
    public void wideStatusCapsuleImmediatelyFollowsItsCompany() throws Exception {
        String layout = projectFile("app/src/main/res/layout/express_widget_4x2.xml");
        String styles = projectFile("app/src/main/res/values/styles.xml");
        String companyStyle = block(
                styles, "<style name=\"DeliveriesExpressWideCompany\"", "</style>");
        String spacerStyle = block(
                styles, "<style name=\"DeliveriesExpressWideTitleSpacer\"", "</style>");

        assertTrue(companyStyle.contains(
                "<item name=\"android:layout_width\">wrap_content</item>"));
        assertFalse(companyStyle.contains("android:layout_weight"));
        assertTrue(companyStyle.contains("<item name=\"android:ellipsize\">end</item>"));
        assertTrue(companyStyle.contains("<item name=\"android:maxLines\">1</item>"));
        assertEquals(3, occurrences(
                layout, "style=\"@style/DeliveriesExpressWideTitleSpacer\""));
        assertTrue(spacerStyle.contains(
                "<item name=\"android:layout_width\">0dp</item>"));
        assertTrue(spacerStyle.contains(
                "<item name=\"android:layout_weight\">1</item>"));

        for (int row = 1; row <= 3; row++) {
            int company = layout.indexOf("@+id/widget_express_company" + row);
            int status = layout.indexOf("@+id/widget_express_status" + row);
            int spacer = layout.indexOf(
                    "style=\"@style/DeliveriesExpressWideTitleSpacer\"", status);
            assertTrue(company >= 0);
            assertTrue(status > company);
            assertTrue(spacer > status);
        }
    }

    @Test
    public void unknownWidgetStatusUsesNeutralCopy() throws Exception {
        String strings = projectFile("app/src/main/res/values/strings.xml");

        assertTrue(strings.contains(
                "<string name=\"widget_status_unknown\">暂无状态</string>"));
    }

    @Test
    public void widePopulatedStateMatchesPipiWithOnlyTheRequestedDifferences()
            throws Exception {
        String layout = projectFile("app/src/main/res/layout/express_widget_4x2.xml");
        String styles = projectFile("app/src/main/res/values/styles.xml");
        String provider = source("ExpressWidgetProvider.java");

        assertEquals(1, occurrences(layout, "@+id/widget_express_header"));
        assertEquals(3, occurrences(layout, "@+id/widget_express_company"));
        assertEquals(3, occurrences(layout, "@+id/widget_express_status"));
        assertEquals(3, occurrences(layout, "@+id/widget_express_detail"));
        assertTrue(provider.contains("R.string.widget_express_count"));
        assertTrue(provider.contains("ExpressWidgetPresentation.activeCount(items)"));
        assertTrue(layout.contains(
                "android:padding=\"@dimen/express_widget_search_edge_inset\""));
        assertTrue(layout.contains("android:paddingBottom=\"8dp\""));
        assertTrue(layout.contains(
                "style=\"@style/DeliveriesExpressWidgetSearch\""));
        assertTrue(styles.contains(
                "<item name=\"android:layout_width\">22dp</item>"));
        assertTrue(styles.contains(
                "<item name=\"android:layout_height\">22dp</item>"));
        assertTrue(provider.contains(
                "static final int MAX_WIDE_ITEMS = ExpressWidgetRowPolicy.WIDE_ROW_LIMIT;"));
        assertTrue(provider.contains("items.subList(0, MAX_WIDE_ITEMS)"));
        assertFalse(provider.contains(
                "ExpressWidgetPresentation.first(items, MAX_WIDE_ITEMS)"));
        assertTrue(provider.contains("typography.lineBox("));
        assertTrue(provider.contains("rowLayout.verticalPaddingPx"));
        assertTrue(provider.contains(
                "views.setInt(R.id.widget_express_search, \"setColorFilter\", accent);"));
        assertTrue(provider.contains(
                "ExpressWidgetPalette.accent(context, displayed.get(0))"));
    }

    @Test
    public void wideEmptyStateUsesTheSharedDeliveryVehicleStructure() throws Exception {
        String layout = projectFile("app/src/main/res/layout/express_widget_4x2.xml");
        String provider = source("ExpressWidgetProvider.java");
        String strings = projectFile("app/src/main/res/values/strings.xml");

        assertTrue(layout.contains("@+id/widget_express_empty"));
        assertTrue(layout.contains("android:layout_height=\"0dp\""));
        assertTrue(layout.contains("android:layout_weight=\"1\""));
        assertTrue(layout.contains("android:gravity=\"center\""));
        assertTrue(layout.contains("@drawable/widget_express_empty_vehicle"));
        assertTrue(layout.contains("android:layout_width=\"68dp\""));
        assertTrue(layout.contains("android:layout_height=\"68dp\""));
        assertTrue(layout.contains("android:layout_marginTop=\"4dp\""));
        assertTrue(layout.contains("android:textSize=\"16sp\""));
        assertTrue(layout.contains("@+id/widget_express_line_art"));
        assertTrue(layout.contains("@drawable/widget_express_empty_4x2_bg"));
        assertTrue(provider.contains(
                "views.setViewVisibility(R.id.widget_express_brand_gradient,"));
        assertTrue(provider.contains("R.drawable.widget_express_empty_gradient_mask"));
        assertTrue(provider.contains(
                "views.setViewVisibility(R.id.widget_express_brand_gradient, View.VISIBLE)"));
        assertTrue(strings.contains(
                "<string name=\"widget_empty_message\">暂无快递</string>"));
    }

    @Test
    public void compactAndWideEmptyStatesShareTheSameDeliveryVehicle()
            throws Exception {
        String wide = projectFile("app/src/main/res/layout/express_widget_4x2.xml");
        String compact = projectFile("app/src/main/res/layout/express_widget_2x2.xml");

        assertEquals(1, occurrences(wide, "@+id/widget_express_brand_gradient"));
        assertEquals(1, occurrences(compact, "@+id/widget_compact_brand_gradient"));
        assertTrue(compact.contains("android:alpha=\"0.22\""));
        assertTrue(compact.contains("@drawable/widget_express_empty_vehicle"));
        assertTrue(wide.contains("@drawable/widget_express_empty_vehicle"));
    }

    @Test
    public void compactPopulatedStateKeepsTheCourierLeftOfItsTwoLineIdentity()
            throws Exception {
        String layout = projectFile("app/src/main/res/layout/express_widget_2x2.xml");
        String provider = source("ExpressWidgetProvider.java");
        String metrics = source("ExpressWidgetLayout.java");
        String header = block(layout, "@+id/widget_compact_top", "</LinearLayout>");

        assertTrue(layout.contains("@+id/widget_priority_status"));
        assertTrue(layout.contains("@+id/widget_compact_courier_logo"));
        assertTrue(layout.contains("@+id/widget_compact_company"));
        assertTrue(layout.contains("@+id/widget_compact_detail"));
        assertTrue(header.indexOf("@+id/widget_compact_courier_logo")
                < header.indexOf("@+id/widget_compact_identity"));
        assertTrue(header.indexOf("@+id/widget_priority_status")
                < header.indexOf("@+id/widget_compact_company"));
        assertTrue(layout.contains("android:maxLines=\"3\""));
        assertTrue(layout.contains("android:layout_width=\"44dp\""));
        assertTrue(layout.contains("android:layout_height=\"44dp\""));
        assertTrue(layout.contains("android:lineSpacingMultiplier=\"1.2\""));
        assertTrue(layout.contains("android:gravity=\"center_vertical\""));
        assertFalse(layout.contains("android:layout_alignParentBottom=\"true\""));
        assertTrue(layout.contains("@+id/widget_compact_all"));
        assertTrue(layout.contains("@+id/widget_compact_all_text"));
        assertFalse(layout.contains("widget_compact_logo1"));
        assertFalse(layout.contains("widget_active_count"));
        assertFalse(layout.contains("widget_compact_overlap_1"));
        assertTrue(provider.contains("ExpressWidgetPresentation.first(items, 1)"));
        assertTrue(provider.contains("accent = ExpressWidgetPalette.emptyAccent(context);"));
        assertTrue(provider.contains("accent = ExpressWidgetPalette.accent(context, item);"));
        assertTrue(provider.contains(
                "views.setInt(R.id.widget_compact_brand_gradient, \"setColorFilter\", accent);"));
        assertTrue(provider.contains("R.id.widget_compact_courier_logo"));
        assertTrue(provider.contains("R.id.widget_compact_company"));
        assertFalse(provider.contains("item.companyName"));
        assertEquals(2, occurrences(
                provider, "ExpressWidgetPresentation.rowIdentity(item)"));
        assertTrue(provider.contains("StatusStyle.forSemantic(item.semantic).foreground"));
        assertTrue(provider.contains("R.id.widget_compact_detail"));
        assertTrue(provider.contains("R.id.widget_compact_all_text"));
        assertTrue(provider.contains("WidgetHostMetrics.currentHeightDp(context, options)"));
        assertTrue(metrics.contains("companyTextSizeSp"));
        assertTrue(header.contains("android:layout_marginEnd=\"9dp\""));
        assertFalse(header.contains("android:layout_marginStart=\"9dp\""));
        assertTrue(layout.contains("android:textSize=\"20sp\""));
        assertTrue(layout.contains("android:textSize=\"12sp\""));
        assertTrue(layout.contains("android:textSize=\"13sp\""));
        assertTrue(metrics.contains("widthDp / COMPACT_REFERENCE_WIDTH_DP"));
        assertTrue(metrics.contains("heightDp / COMPACT_REFERENCE_HEIGHT_DP"));
        assertTrue(metrics.contains("clamp(42f * scale, 38f, 44f)"));
        assertTrue(provider.contains("options.getFloat(\"hsResizeRatio\", 1f)"));
        assertTrue(provider.contains("hostRatio < 0.5f || hostRatio > 1.5f"));
        assertTrue(provider.contains("layout.logoHorizontalInsetDp"));
        assertTrue(provider.contains("layout.logoVerticalInsetDp"));
        assertTrue(provider.contains("\"setMaxLines\", layout.detailLineLimit"));
        assertTrue(provider.contains(
                "views.setInt(R.id.widget_compact_empty_search, \"setColorFilter\", accent);"));
    }

    @Test
    public void compactIdentityVisibleHeightTracksTheResponsiveLogoAcrossApiPaths()
            throws Exception {
        String layout = projectFile("app/src/main/res/layout/express_widget_2x2.xml");
        String provider = source("ExpressWidgetProvider.java");
        String metrics = source("ExpressWidgetLayout.java");
        String api31 = source("ExpressWidgetApi31.java");
        String identity = block(
                layout, "@+id/widget_compact_identity", "</LinearLayout>");

        assertTrue(identity.contains("android:layout_width=\"0dp\""));
        assertTrue(identity.contains("android:layout_height=\"44dp\""));
        assertTrue(identity.contains("android:layout_weight=\"1\""));
        assertEquals(2, occurrences(identity, "android:layout_height=\"0dp\""));
        assertEquals(1, occurrences(identity, "android:layout_weight=\"24\""));
        assertEquals(1, occurrences(identity, "android:layout_weight=\"14\""));
        assertEquals(2, occurrences(
                identity, "android:gravity=\"center_vertical|start\""));
        assertEquals(2, occurrences(identity, "android:includeFontPadding=\"false\""));
        assertEquals(1, occurrences(identity, "android:lineHeight=\"24dp\""));
        assertEquals(1, occurrences(identity, "android:lineHeight=\"14dp\""));
        assertTrue(metrics.contains("final float courierLogoSizeDp"));
        assertTrue(metrics.contains("COMPACT_STATUS_TEXT_SIZE_SP = 20f"));
        assertTrue(metrics.contains("COMPACT_COMPANY_TEXT_SIZE_SP = 12f"));
        assertTrue(metrics.contains("COMPACT_STATUS_TEXT_SIZE_SP,"));
        assertTrue(metrics.contains("COMPACT_COMPANY_TEXT_SIZE_SP,"));
        assertFalse(metrics.contains("COMPACT_STATUS_TO_LOGO_RATIO"));
        assertFalse(metrics.contains("COMPACT_COMPANY_TO_LOGO_RATIO"));
        assertTrue(api31.contains("static void applyCompactHeaderSize("));
        assertTrue(api31.contains(
                "setViewLayoutHeight(R.id.widget_compact_identity,"));
        assertEquals(3, occurrences(
                api31, "logoSizeDp, TypedValue.COMPLEX_UNIT_DIP"));
        assertTrue(provider.contains(
                "ExpressWidgetApi31.applyCompactHeaderSize("));
        assertTrue(provider.contains("views, layout.courierLogoSizeDp"));
        assertTrue(provider.contains(
                "views.setViewPadding(R.id.widget_compact_identity, 0, 0, 0, 0);"));
        assertTrue(provider.contains(
                "layout.logoVerticalInsetDp * density"));
        assertTrue(provider.contains(
                "views.setViewPadding(R.id.widget_compact_identity,"));
        assertTrue(provider.contains(
                "0, compatHeaderVerticalInsetPx, 0, compatHeaderVerticalInsetPx);"));
    }

    @Test
    public void compactPillUsesTheIosOpticalIconAndLabelTokens()
            throws Exception {
        String layout = projectFile("app/src/main/res/layout/express_widget_2x2.xml");
        String provider = source("ExpressWidgetProvider.java");
        String metrics = source("ExpressWidgetLayout.java");
        String api31 = source("ExpressWidgetApi31.java");
        String pill = block(layout, "@+id/widget_compact_all", "</LinearLayout>");

        assertTrue(pill.contains("android:layout_height=\"40dp\""));
        assertTrue(pill.contains("@+id/widget_compact_all_icon"));
        assertTrue(pill.contains("android:layout_width=\"16dp\""));
        assertTrue(pill.contains("android:layout_height=\"16dp\""));
        assertTrue(pill.contains("android:gravity=\"center\""));
        assertTrue(pill.contains("android:layout_marginStart=\"6dp\""));
        assertTrue(pill.contains("android:textSize=\"14sp\""));
        assertTrue(metrics.contains("final float pillContentSize"));
        assertTrue(metrics.contains("final float pillIconSizeDp"));
        assertTrue(metrics.contains("COMPACT_PILL_TEXT_SIZE_SP,"));
        assertTrue(metrics.contains("compactPillIconSize(widthDp),"));
        assertFalse(metrics.contains("PILL_ICON_OPTICAL_SCALE"));
        assertTrue(metrics.contains("final float pillIconInsetDp"));
        assertTrue(api31.contains("static void applyCompactPillIconSize("));
        assertTrue(api31.contains(
                "setViewLayoutWidth(R.id.widget_compact_all_icon,"));
        assertTrue(api31.contains(
                "setViewLayoutHeight(R.id.widget_compact_all_icon,"));
        assertTrue(provider.contains(
                "ExpressWidgetApi31.applyCompactPillIconSize("));
        assertTrue(provider.contains("views, layout.pillIconSizeDp"));
        assertTrue(provider.contains(
                "views.setTextViewTextSize(R.id.widget_compact_all_text,"));
        assertTrue(provider.contains(
                "TypedValue.COMPLEX_UNIT_SP, layout.pillContentSize"));
        assertTrue(provider.contains("layout.pillIconInsetDp * density"));
        assertTrue(provider.contains(
                "views.setViewPadding(R.id.widget_compact_all_icon,"));
        assertTrue(provider.contains(
                "pillIconInsetPx, pillIconInsetPx, pillIconInsetPx, pillIconInsetPx"));
        assertTrue(provider.contains(
                "views.setViewPadding(R.id.widget_compact_all,"));
        assertTrue(provider.contains("layout.pillHorizontalPaddingDp"));
    }

    @Test
    public void latestDetailTextUsesOneHeightProfileAcrossCompactAndWideCards()
            throws Exception {
        String provider = source("ExpressWidgetProvider.java");
        String metrics = source("ExpressWidgetLayout.java");

        assertTrue(metrics.contains("COMPACT_DETAIL_TEXT_SIZE_SP = 12f"));
        assertTrue(metrics.contains("REGULAR_DETAIL_TEXT_SIZE_SP = 13f"));
        assertTrue(metrics.contains("compactDetailTextSize(widthDp, heightDp)"));
        assertTrue(metrics.contains("wideDetailTextSize(heightDp)"));
        assertTrue(provider.contains(
                "ExpressWidgetLayout.Medium mediumLayout =\n"
                        + "                    ExpressWidgetLayout.medium(hostHeightDp);"));
        assertTrue(provider.contains("mediumLayout.detailTextSizeSp"));
        assertTrue(provider.contains("layout.detailTextSizeSp"));
        assertFalse(provider.contains(
                "typography.textSize(WidgetTypographyProfile.Token.SUPPORT)"));
    }

    @Test
    public void emptyVehicleAssetIsSquareRgbaArtworkWithRealTransparency() throws Exception {
        Path asset = projectPath(
                "app/src/main/res/drawable-nodpi/widget_express_empty_vehicle.png");
        assertTrue(Files.isRegularFile(asset));
        PngRgba image = decodeRgbaPng(Files.readAllBytes(asset));
        assertNotNull(image);
        assertEquals(768, image.width);
        assertEquals(768, image.height);
        assertTrue(image.hasTransparentPixel);
        assertTrue(image.hasVisiblePixel);
    }

    @Test
    public void widgetPickerUsesEmptyPreviewLayoutsWithoutDuplicateDescriptions()
            throws Exception {
        String baseSmall = projectFile("app/src/main/res/xml/express_2x2_appwidget.xml");
        String baseMedium = projectFile("app/src/main/res/xml/express_4x2_appwidget.xml");
        String modernSmall = projectFile(
                "app/src/main/res/xml-v31/express_2x2_appwidget.xml");
        String modernMedium = projectFile(
                "app/src/main/res/xml-v31/express_4x2_appwidget.xml");
        String smallLayout = projectFile("app/src/main/res/layout/express_widget_2x2.xml");
        String mediumLayout = projectFile("app/src/main/res/layout/express_widget_4x2.xml");
        String previewSource = projectFile("tools/widget-preview.html");

        for (String metadata : new String[]{
                baseSmall, baseMedium, modernSmall, modernMedium}) {
            assertFalse(metadata.contains("android:description="));
            assertTrue(metadata.contains("android:previewImage="));
        }
        assertTrue(modernSmall.contains(
                "android:previewLayout=\"@layout/express_widget_2x2\""));
        assertTrue(modernMedium.contains(
                "android:previewLayout=\"@layout/express_widget_4x2\""));
        assertTrue(smallLayout.contains("android:visibility=\"gone\""));
        assertTrue(mediumLayout.contains("android:visibility=\"gone\""));
        assertTrue(previewSource.contains("暂无快递"));
        assertTrue(previewSource.contains("我的快递"));
        assertFalse(previewSource.contains("待取件"));
        assertFalse(previewSource.contains("快递动态"));
    }

    @Test
    public void legacyPickerPreviewsCoverBothSizesAndDayNightThemes() throws Exception {
        String[] paths = {
                "app/src/main/res/drawable-xxxhdpi/widget_express_2x2_preview.png",
                "app/src/main/res/drawable-xxxhdpi/widget_express_4x2_preview.png",
                "app/src/main/res/drawable-night-xxxhdpi/widget_express_2x2_preview.png",
                "app/src/main/res/drawable-night-xxxhdpi/widget_express_4x2_preview.png"
        };
        int[][] dimensions = {{640, 672}, {1360, 672}, {640, 672}, {1360, 672}};
        for (int index = 0; index < paths.length; index++) {
            PngRgba preview = decodeRgbaPng(Files.readAllBytes(projectPath(paths[index])));
            assertEquals(dimensions[index][0], preview.width);
            assertEquals(dimensions[index][1], preview.height);
            assertTrue(preview.hasTransparentPixel);
            assertTrue(preview.hasVisiblePixel);
        }
    }

    private static int occurrences(String source, String needle) {
        int count = 0;
        int offset = 0;
        while ((offset = source.indexOf(needle, offset)) >= 0) {
            count++;
            offset += needle.length();
        }
        return count;
    }

    private static String block(String source, String id, String endTag) {
        int start = source.indexOf(id);
        int end = source.indexOf(endTag, start);
        assertTrue(start >= 0);
        assertTrue(end > start);
        return source.substring(start, end + endTag.length());
    }

    private static PngRgba decodeRgbaPng(byte[] source) throws Exception {
        byte[] signature = {(byte) 0x89, 'P', 'N', 'G', 13, 10, 26, 10};
        assertTrue(source.length >= signature.length);
        for (int index = 0; index < signature.length; index++) {
            assertEquals(signature[index], source[index]);
        }

        int width = 0;
        int height = 0;
        ByteArrayOutputStream compressed = new ByteArrayOutputStream();
        int offset = signature.length;
        while (offset + 12 <= source.length) {
            int length = readInt(source, offset);
            String type = new String(source, offset + 4, 4, StandardCharsets.US_ASCII);
            int dataOffset = offset + 8;
            assertTrue(length >= 0 && dataOffset + length + 4 <= source.length);
            if ("IHDR".equals(type)) {
                assertEquals(13, length);
                width = readInt(source, dataOffset);
                height = readInt(source, dataOffset + 4);
                assertEquals(8, source[dataOffset + 8] & 0xff);
                assertEquals(6, source[dataOffset + 9] & 0xff);
                assertEquals(0, source[dataOffset + 10] & 0xff);
                assertEquals(0, source[dataOffset + 11] & 0xff);
                assertEquals(0, source[dataOffset + 12] & 0xff);
            } else if ("IDAT".equals(type)) {
                compressed.write(source, dataOffset, length);
            } else if ("IEND".equals(type)) {
                break;
            }
            offset = dataOffset + length + 4;
        }
        assertTrue(width > 0 && height > 0 && compressed.size() > 0);

        byte[] filtered;
        try (InflaterInputStream inflater = new InflaterInputStream(
                new ByteArrayInputStream(compressed.toByteArray()))) {
            filtered = inflater.readAllBytes();
        }
        int stride = width * 4;
        assertEquals(height * (stride + 1), filtered.length);
        byte[] pixels = new byte[height * stride];
        boolean transparent = false;
        boolean visible = false;
        for (int y = 0; y < height; y++) {
            int sourceRow = y * (stride + 1);
            int targetRow = y * stride;
            int filter = filtered[sourceRow] & 0xff;
            for (int x = 0; x < stride; x++) {
                int left = x >= 4 ? pixels[targetRow + x - 4] & 0xff : 0;
                int up = y > 0 ? pixels[targetRow - stride + x] & 0xff : 0;
                int upperLeft = y > 0 && x >= 4
                        ? pixels[targetRow - stride + x - 4] & 0xff : 0;
                int predictor;
                switch (filter) {
                    case 0: predictor = 0; break;
                    case 1: predictor = left; break;
                    case 2: predictor = up; break;
                    case 3: predictor = (left + up) / 2; break;
                    case 4: predictor = paeth(left, up, upperLeft); break;
                    default: throw new IllegalArgumentException("Unsupported PNG filter " + filter);
                }
                pixels[targetRow + x] = (byte) ((filtered[sourceRow + 1 + x]
                        + predictor) & 0xff);
            }
            for (int x = 3; x < stride; x += 4) {
                int alpha = pixels[targetRow + x] & 0xff;
                transparent |= alpha == 0;
                visible |= alpha > 0;
            }
        }
        return new PngRgba(width, height, transparent, visible);
    }

    private static int readInt(byte[] source, int offset) {
        return (source[offset] & 0xff) << 24
                | (source[offset + 1] & 0xff) << 16
                | (source[offset + 2] & 0xff) << 8
                | (source[offset + 3] & 0xff);
    }

    private static int paeth(int left, int up, int upperLeft) {
        int estimate = left + up - upperLeft;
        int leftDistance = Math.abs(estimate - left);
        int upDistance = Math.abs(estimate - up);
        int upperLeftDistance = Math.abs(estimate - upperLeft);
        if (leftDistance <= upDistance && leftDistance <= upperLeftDistance) return left;
        return upDistance <= upperLeftDistance ? up : upperLeft;
    }

    private static final class PngRgba {
        final int width;
        final int height;
        final boolean hasTransparentPixel;
        final boolean hasVisiblePixel;

        PngRgba(int width, int height, boolean hasTransparentPixel,
                boolean hasVisiblePixel) {
            this.width = width;
            this.height = height;
            this.hasTransparentPixel = hasTransparentPixel;
            this.hasVisiblePixel = hasVisiblePixel;
        }
    }

    private static String source(String name) throws Exception {
        return projectFile("app/src/main/java/me/pipi/deliveries/widget/" + name);
    }

    private static String projectFile(String relative) throws Exception {
        return Files.readString(projectPath(relative), StandardCharsets.UTF_8);
    }

    private static Path projectPath(String relative) {
        Path path = Path.of(relative);
        if (!Files.isRegularFile(path) && relative.startsWith("app/")) {
            path = Path.of(relative.substring("app/".length()));
        }
        if (!Files.isRegularFile(path) && relative.startsWith("tools/")) {
            path = Path.of("..").resolve(relative);
        }
        return path;
    }
}
