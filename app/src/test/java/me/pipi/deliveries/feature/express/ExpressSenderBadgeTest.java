package me.pipi.deliveries.feature.express;
import android.app.Application;
import android.view.View;
import android.widget.TextView;
import me.pipi.deliveries.model.StatusSemantic;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;
import static org.junit.Assert.*;
@RunWith(RobolectricTestRunner.class)
@Config(sdk=31,manifest=Config.NONE,application=Application.class)
public class ExpressSenderBadgeTest {
 // Owner 2026-11-27 (修改 29, five-family): capsule base colour at 12% (0x1F) in light and 22% (0x38) in night under the appearance's text colour.
 @Test public void rebindingAReceiverHidesTheExistingSenderBadge() {
  BadgeView view=new BadgeView();
  ExpressSenderBadge.apply(view,true,StatusSemantic.DELIVERY,"派送中");
  assertEquals("寄",view.getText().toString()); assertEquals(View.VISIBLE,view.getVisibility());
  assertEquals(0xFFE65100,view.getCurrentTextColor());
  assertEquals(0x1fff9800,((android.graphics.drawable.GradientDrawable) view.getBackground()).getColor().getDefaultColor());
  assertFalse(view.getIncludeFontPadding()); assertEquals(android.graphics.Typeface.BOLD,view.requestedStyle);
  ExpressSenderBadge.apply(view,false,StatusSemantic.DANGER,"异常件");
  assertEquals(View.GONE,view.getVisibility());
 }
 @Config(qualifiers="night")
 @Test public void nightBadgeUsesDarkCapsuleFillAt22PercentUnderNightTextColour() {
  BadgeView view=new BadgeView();
  ExpressSenderBadge.apply(view,true,StatusSemantic.WAITING_PICKUP,"待取件");
  assertEquals(0xFFFF8A65,view.getCurrentTextColor());
  assertEquals(0x38f4511e,((android.graphics.drawable.GradientDrawable) view.getBackground()).getColor().getDefaultColor());
 }
 private static final class BadgeView extends TextView {
  int requestedStyle;
  BadgeView() { super(new android.view.ContextThemeWrapper(RuntimeEnvironment.getApplication(), com.google.android.material.R.style.Theme_Material3_DayNight)); }
  @Override public void setTypeface(android.graphics.Typeface typeface,int style) {
   requestedStyle=style;
   super.setTypeface(typeface,style);
  }
 }
}
