package me.pipi.deliveries.network;
import me.pipi.deliveries.data.*;
import android.app.Application;
import android.content.Context;
import me.pipi.deliveries.model.*;
import me.pipi.deliveries.network.ExpressDiscoveryClient;
import org.json.*;
import org.junit.*;
import org.junit.runner.RunWith;
import org.robolectric.*;
import org.robolectric.annotation.*;
import static org.junit.Assert.*;

@RunWith(RobolectricTestRunner.class)
@Config(sdk=31, manifest=Config.NONE, application=Application.class)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
public class AutomaticFeedPersistenceTest {
 private Context context; private ExpressDatabase database; private ExpressRepository repository;
 private static final String PHONE="13900000001";
 @Before public void setup() throws Exception {
  context=RuntimeEnvironment.getApplication(); context.deleteDatabase(ExpressDatabase.DATABASE);
  context.getSharedPreferences("deliveries_repository_migrations",0).edit().clear().commit();
  database=new ExpressDatabase(context);
  var constructor=ExpressRepository.class.getDeclaredConstructor(Context.class,ExpressDatabase.class);
  constructor.setAccessible(true);
  repository=constructor.newInstance(context,database);
  repository.bindPhoneLocally(PHONE,"interface5");
 }
 @After public void close(){database.close();context.deleteDatabase(ExpressDatabase.DATABASE);}
 private ExpressQueryResult parse(boolean jd) throws Exception {
  JSONObject feed=new JSONObject().put("mailNo",jd?"1234567890123456":"ZTO_SYNTHETIC_01")
   .put("cpCode",jd?"JDKD":"ZTO").put("name",jd?"京东物流":"中通快递")
   .put("provider",jd?"JingDong":"CaiNiao").put("phone",PHONE).put("stateNum",104)
   .put("details",new JSONArray().put(new JSONObject().put("time","2026-09-09 18:00:00").put("desc","运输中")));
  return jd ? ExpressDiscoveryClient.parseAccountOrder(feed) : ExpressDiscoveryClient.parseExpress(feed,"",PHONE);
 }
 @Test public void cainiaoParserToDatabase() throws Exception {
  ExpressQueryResult r=parse(false);
  assertNotNull(r); assertEquals(StatusSemantic.TRANSIT,r.semantic); assertTrue(r.carrierIdentityEvidence);
  repository.saveInterface5(r,PHONE);
  boolean inserted=repository.findByWaybill(r.waybill,"interface5")!=null;
  assertTrue("Current parser result must establish its source owner",inserted);
 }
 @Test public void jingdongParserToProjectionClaim() throws Exception {
  ExpressQueryResult r=parse(true); assertNotNull(r);
  repository.saveInterface5OrderSummary(r,PHONE);
  ExpressItem row=repository.findByWaybill(r.waybill,"interface5"); assertNotNull(row);
  boolean claim=repository.captureManualQueryOwner(row)!=null;
  assertTrue("Current parser result must permit the existing projection path",claim);
 }

 @Test public void genericUpdateAdvancesExistingOwnerClockAndKeepsRealSummary() throws Exception {
  ExpressQueryResult previous=parse(false);
  repository.saveInterface5(previous,PHONE);
  JSONObject raw=new JSONObject().put("mailNo",previous.waybill).put("cpCode","ZTO")
   .put("name","中通快递").put("provider","CaiNiao").put("phone",PHONE).put("stateNum",105)
   .put("details",new JSONArray()
    .put(new JSONObject().put("time","2026-09-12 10:00:00").put("desc","快递状态已更新，点击查看>>"))
    .put(new JSONObject().put("time","2026-09-09 18:00:00").put("desc","快件已到达转运中心")));
  repository.saveInterface5(ExpressDiscoveryClient.parseExpress(raw,"",PHONE),PHONE);
  ExpressItem stored=repository.findByWaybill(previous.waybill,"interface5");
  assertEquals(StatusSemantic.DELIVERY,stored.semantic);
  assertEquals(ExpressTimeline.parseTime("2026-09-12 10:00:00"),stored.statusEventTime);
  assertEquals("快件已到达转运中心",stored.latestDetail);
  ExpressItem visible=repository.listVisible("interface5").get(0);
  assertEquals(stored.statusEventTime,visible.statusEventTime);
  assertEquals(stored.latestDetail,visible.latestDetail);
  assertTrue(repository.automaticSourceTimeline(visible).tracksJson.contains(stored.latestDetail));
 }

 @Test public void emptyCainiaoFeedDisplaysItsOwnQueryActivityWithoutChangingFeed() throws Exception {
  JSONObject raw=new JSONObject().put("mailNo","ZTO_SYNTHETIC_01").put("cpCode","ZTO")
   .put("name","中通快递").put("provider","CaiNiao").put("phone",PHONE).put("stateNum",104)
   .put("details",new JSONArray().put(new JSONObject().put("time","2026-09-09 18:00:00")
    .put("desc","快递状态已更新，点击查看>>")));
  ExpressQueryResult feed=ExpressDiscoveryClient.parseExpress(raw,"",PHONE);
  repository.saveInterface5(feed,PHONE);
  ExpressItem owner=repository.findByWaybill(feed.waybill,"interface5");
  raw.put("stateNum",105).put("details",new JSONArray().put(new JSONObject()
   .put("time","2026-09-09 18:10:00").put("desc","快件已到达深圳转运中心")));
  ExpressQueryResult query=ExpressDiscoveryClient.parseExpress(raw,"",PHONE);
  assertTrue(repository.saveInterface5Query(query,owner,repository.bindingGeneration(PHONE,"interface5")));
  ExpressItem visible=repository.listVisible("interface5").get(0);
  assertEquals("A real same-owner query event must fill the empty Home activity",query.latestDetail,visible.latestDetail);
  assertEquals(query.latestTime,visible.latestTime);
  assertEquals(StatusSemantic.DELIVERY,visible.semantic);
  assertEquals(query.statusEventTime,visible.statusEventTime);
  assertEquals("[]",repository.automaticSourceTimeline(visible).tracksJson);
  assertEquals(query.latestDetail,repository.find(owner.rowId).latestDetail);
 }

 @Test public void newerSameAccountQueryAdvancesExistingHomeActivity() throws Exception {
  ExpressQueryResult feed=parse(false);
  repository.saveInterface5(feed,PHONE);
  ExpressItem owner=repository.findByWaybill(feed.waybill,"interface5");
  JSONObject raw=new JSONObject().put("mailNo",feed.waybill).put("cpCode","ZTO")
   .put("name","中通快递").put("provider","CaiNiao").put("phone",PHONE).put("stateNum",105)
   .put("details",new JSONArray().put(new JSONObject().put("time","2026-09-09 18:10:00")
    .put("desc","快件已到达深圳转运中心")));
  assertTrue(repository.saveInterface5Query(ExpressDiscoveryClient.parseExpress(raw,"",PHONE),
   owner,repository.bindingGeneration(PHONE,"interface5")));
  ExpressItem visible=repository.listVisible("interface5").get(0);
  assertEquals("快件已到达深圳转运中心",visible.latestDetail);
  assertEquals("2026-09-09 18:10:00",visible.latestTime);
  assertEquals(StatusSemantic.DELIVERY,visible.semantic);
  assertEquals(feed.tracksJson,repository.automaticSourceTimeline(visible).tracksJson);
 }

 @Test public void listSnapshotKeepsSenderAndOriginAcrossProjectionQueryAndReload() throws Exception {
  JSONObject raw=new JSONObject().put("mailNo","1234567890123456").put("cpCode","JDKD")
   .put("name","京东物流").put("provider","JingDong").put("phone",PHONE)
   .put("sendPhone",PHONE).put("stateNum",101).put("details",new JSONArray().put(new JSONObject()
    .put("time","2026-09-01 10:00:00").put("desc","您提交了订单，请等待第三方卖家系统确认")));
  ExpressQueryResult initial=ExpressDiscoveryClient.parseAccountOrder(raw);
  repository.saveInterface5OrderSummary(initial,PHONE);
  ExpressItem owner=repository.findByWaybill(initial.waybill,"interface5");
  assertEquals(ExpressTimeline.parseTime("2026-09-01 10:00:00"),owner.listOriginAtMs);
  assertTrue(owner.sender);
  assertTrue(repository.saveOrderProjection(owner,"interface5","JD_SYNTHETIC_12345","京东物流",null));
  raw.put("stateNum",104).put("details",new JSONArray().put(new JSONObject()
   .put("time","2026-09-12 10:00:00").put("desc","快件已到达转运中心")));
  repository.saveInterface5OrderSummary(ExpressDiscoveryClient.parseAccountOrder(raw),PHONE);
  ExpressItem updated=repository.find(owner.rowId);
  ExpressQueryResult list=repository.automaticSourceTimeline(updated);
  assertFalse(list.tracksJson.contains("提交了订单"));
  assertEquals(owner.listOriginAtMs,updated.listOriginAtMs);
  assertEquals("JD_SYNTHETIC_12345",updated.projectedWaybill);
  assertTrue(updated.sender);
  raw.put("sendPhone","13800000002");
  ExpressQueryResult query=ExpressDiscoveryClient.parseAccountOrder(raw);
  assertTrue(repository.saveInterface5Query(query,updated,repository.bindingGeneration(PHONE,"interface5")));
  ExpressItem reread=repository.listVisible("interface5").get(0);
  assertEquals(PHONE,reread.senderPhone);
  assertTrue(reread.sender);
  assertEquals(owner.listOriginAtMs,reread.listOriginAtMs);
 }

 @Test public void senderRequiresAnExactBoundListPhoneAndAbsentListFieldClearsIt() throws Exception {
  ExpressQueryResult feed=parse(false).withAccountListMetadata("0001",0L);
  repository.saveInterface5(feed,PHONE);
  assertFalse(repository.findByWaybill(feed.waybill,"interface5").sender);
  repository.saveInterface5(feed.withAccountListMetadata(PHONE,0L),PHONE);
  assertTrue(repository.findByWaybill(feed.waybill,"interface5").sender);
  repository.saveInterface5(feed.withAccountListMetadata("",0L),PHONE);
  assertFalse(repository.findByWaybill(feed.waybill,"interface5").sender);
 }

 @Test public void interface6ParserToDatabase() throws Exception {
  repository.bindPhoneLocally(PHONE,"interface6");
  JSONObject feed=new JSONObject().put("mailNo","ZTO_SYNTHETIC_06").put("cpCode","ZTO")
   .put("cpName","中通快递").put("provider","CaiNiao").put("subPhone",PHONE)
   .put("logsiticsStatus","1").put("logisticsStatusDesc","运输中")
   .put("lastLogisticDetail","运输中").put("logisticsGmtModified","2026-09-09 18:00:00");
  ExpressQueryResult r=ExpressSubscriptionClient.parseExpress(feed,"","");
  assertNotNull(r); assertTrue(r.carrierIdentityEvidence); assertNotEquals(StatusSemantic.UNKNOWN,r.semantic);
  repository.saveInterface6(r,PHONE);
  boolean inserted=repository.findByWaybill(r.waybill,"interface6")!=null;
  assertTrue("Current interface6 parser result must establish its source owner",inserted);
 }
 @Test public void interface6CainiaoH5PersistsAndProjectsWithoutV5Binding() throws Exception {
  repository.unbindPhone(PHONE,"interface5"); repository.bindPhoneLocally(PHONE,"interface6");
  JSONObject raw=new JSONObject().put("mailNo","ZTOV6SYNTHETIC").put("cpCode","ZTO")
   .put("cpName","中通快递").put("provider","CaiNiao").put("subPhone",PHONE)
   .put("logsiticsStatus","1").put("logisticsStatusDesc","运输中")
   .put("lastLogisticDetail","快递状态已更新，点击查看").put("logisticsGmtModified","2026-09-09 18:00:00")
   .put("sendPhone",PHONE);
  ExpressQueryResult feed=ExpressSubscriptionClient.parseExpress(raw,"","");
  repository.saveInterface6(feed,PHONE);
  ExpressItem owner=repository.findByWaybill(feed.waybill,"interface6");
  String time="2026-09-09 18:01:00";
  ExpressQueryResult h5=new ExpressQueryResult(feed.waybill,"ZTO","中通快递",StatusSemantic.UNKNOWN,
   time,"已揽收 Synthetic H5 event",new JSONArray().put(new JSONObject().put("time",time)
   .put("context","已揽收 Synthetic H5 event")).toString(),"",PHONE,TimelineSlot.CN_H5);
  assertTrue(repository.saveAutomaticDetailTimeline(owner,repository.captureManualQueryOwner(owner),h5,true));
  ExpressItem visible=repository.listVisible("interface6").get(0);
  assertEquals(TimelineSlot.CN_H5,repository.manualDetailTimelineAuthority(visible).provider);
  assertEquals("已揽收 Synthetic H5 event",visible.latestDetail);
  assertEquals(owner.semantic,visible.semantic); assertEquals(owner.statusEventTime,visible.statusEventTime);
  assertTrue(visible.sender);
 }

 @Test public void newerJdOrderPreparationDoesNotRegressProjectedShipment() throws Exception {
  JSONObject raw=new JSONObject().put("mailNo","1234567890123456").put("cpCode","JDKD")
   .put("name","京东物流").put("provider","JingDong").put("phone",PHONE).put("stateNum",104)
   .put("details",new JSONArray().put(new JSONObject().put("time","2026-09-10 10:00:00").put("desc","运输中")));
  ExpressQueryResult transit=ExpressDiscoveryClient.parseAccountOrder(raw);
  repository.saveInterface5OrderSummary(transit,PHONE);
  ExpressItem owner=repository.findByWaybill(transit.waybill,"interface5");
  assertTrue(repository.saveOrderProjection(owner,"interface5","JD_SYNTHETIC_12345","京东物流",null));
  raw.put("stateNum",101).put("details",new JSONArray().put(new JSONObject()
   .put("time","2026-09-12 10:00:00").put("desc","订单已提交")));
  repository.saveInterface5OrderSummary(ExpressDiscoveryClient.parseAccountOrder(raw),PHONE);
  assertEquals(StatusSemantic.TRANSIT,repository.find(owner.rowId).semantic);
 }

}
