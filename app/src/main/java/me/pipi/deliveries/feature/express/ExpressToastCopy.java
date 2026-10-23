package me.pipi.deliveries.feature.express;

/**
 * Express toast copy shared by the three clients (AGENTS §11, 2026-09-03: 快递相关 toast 三端统一；
 * 2026-09-05 扩成整张表：每个场景一行，页面只能按常量取，不许写自由文案).
 *  * The same strings live in Pipi {@code express/ExpressToastCopy.java} and iOS
 * {@code services/express-toast-copy.ts}; change all three together and update the table in
 * docs/EXPRESS_THREE_CLIENT_PARITY_20260901.md.
 * 只有用户手势才弹：后台轮询、推送落库永远静默。
 */
final class ExpressToastCopy {
    /** 手动查件已提交，短 toast 一次。 */
    static final String MANUAL_QUERYING = "正在查询，请稍候";

    /** 手动查件拿到带时间的轨迹。 */
    static final String MANUAL_QUERY_SUCCEEDED = "轨迹加载成功";

    /** 手动查件各级都跑完但没有可用轨迹。 */
    static final String MANUAL_QUERY_NO_TRACK = "暂未查询到或未揽收";

    /** 手动查件失败（非校验、非超时）；上游文案不外露。 */
    static final String MANUAL_QUERY_FAILED = "查询失败，请稍后重试";

    /** 手动查件超时。 */
    static final String MANUAL_QUERY_TIMEOUT = "请求超时，请稍后重试";

    /** A visible manual query needs a usable parcel phone suffix. */
    static final String MANUAL_PHONE_TAIL_REQUIRED = "该快递需要验证手机号后 4 位，请重新添加并填写";

    /** A manual query was submitted for a waybill the list already tracks; no provider runs. */
    static final String ALREADY_IN_LIST = "该快递已在列表中";

    /** 列表下拉：全部成功。 */
    static final String REFRESH_DONE = "刷新完成";

    /** 列表下拉：没有需要刷新的行。 */
    static final String REFRESH_UP_TO_DATE = "当前已是最新";

    /** A partially successful visible refresh keeps the updated list available. */
    static final String LIST_UPDATED = "列表已更新";

    /** 列表下拉：全部失败或整轮抛错。 */
    static final String REFRESH_FAILED = "刷新失败，请稍后重试";

    /** 详情下拉：拉到了新轨迹。 */
    static final String DETAIL_REFRESHED = "轨迹加载成功";

    /** 详情下拉：跑完了但没有更新，已有可用轨迹。 */
    static final String DETAIL_UP_TO_DATE = "当前轨迹已是最新";

    /** 详情下拉：跑完了仍没有可用轨迹。 */
    static final String DETAIL_NO_TRACK = "暂未查询到或未揽收";

    /** 详情下拉抛错且页面上没有任何轨迹可看；有缓存可看时静默。 */
    static final String DETAIL_REFRESH_FAILED = "轨迹更新失败，请稍后重试";

    /** JD union page answered with risk control (HTTP 403 / "刷新几遍还不行"); the order rests 60 min. */
    static final String JD_RISK_CONTROL = "操作过于频繁，请稍后再试";

    static String jdRiskControlRemaining(long remainingMillis) {
        long minutes = Math.max(1L, (remainingMillis + 59_999L) / 60_000L);
        return "京东风控中，请在 " + minutes + " 分钟后重试";
    }

    /** 物流 H5 页（菜鸟半屏、K100 页）打不开。 */
    static final String H5_UNAVAILABLE = "暂时无法加载详情";

    /** An explicit note edit cannot load its current persisted owner or note. */
    static final String USER_NOTE_UNAVAILABLE = "暂时无法编辑，请重试";

    /** Shared copy only; this does not add Pipi note recovery to Lite. */
    static final String USER_NOTE_RECOVERY_FAILED = "处理失败，请重试";
    static final String USER_NOTE_CHANGED = "快递信息已变更，请重新打开备注";
    static final String USER_NOTE_SAVED = "备注已保存";
    static final String USER_NOTE_DELETED = "备注已删除";
    static final String PICKUP_RECORD_DELETED = "该取件码已删除";

    /** 删除成功。 */
    static final String DELETED = "该快递已删除";

    /** 删除失败。 */
    static final String DELETE_FAILED = "删除失败，请稍后重试";

    /** 右滑签收成功（当前只有 iOS 列表行有这个手势）。 */
    static final String SIGNED = "已标记为签收";

    /** 右滑签收失败。 */
    static final String SIGN_FAILED = "标记失败，请稍后重试";

    /** 复制运单号成功。 */
    static final String WAYBILL_COPIED = "运单号已复制";

    /** An explicit copy request could not write to the clipboard. */
    static final String COPY_FAILED = "复制失败，请稍后重试";

    /** 官方电话打不开拨号界面。 */
    static final String DIAL_UNAVAILABLE = "无法打开拨号界面";

    /** 账号类（2026-09-05 补）：验证码已发出。 */
    static final String CODE_SENT = "验证码已发送";

    /** 账号类：验证码发送失败的兜底文案；上游给了原因就显示原因。 */
    static final String CODE_SEND_FAILED = "验证码发送失败，请稍后重试";

    /** Server-side account ownership needs a new SMS verification. */
    static final String PHONE_VERIFICATION_REQUIRED = "绑定失效";
    public static final String PHONE_VERIFICATION_REQUIRED_MESSAGE = "绑定失效，请重新绑定手机号";

    static final String REAUTHORIZE = "重新授权";
    static final String RECOVER_BASIC = "恢复基础模式";
    static final String RECOVERING_BASIC = "正在恢复…";
    static final String DEVICE_REAUTHORIZATION_REQUIRED_MESSAGE = "设备授权已过期，请重新授权。现有记录将会保留。";

    static final String PHONE_BOUND = "手机号已绑定";

    /** 账号类：绑定失败的兜底文案；上游给了原因就显示原因。 */
    static final String BIND_FAILED = "绑定失败，请稍后重试";

    /** 账号类：解绑成功。 */
    static final String PHONE_UNBOUND = "手机号已解绑";

    /** 账号类：解绑失败。 */
    static final String UNBIND_FAILED = "解绑失败，请稍后重试";
    /** 存储类：本地状态每个副本都无法迁移时的提示，不当成空列表（2026-09-06，iOS 先用）。 */
    static final String STATE_LOAD_FAILED = "本地快递数据读取失败";

    /** 列表下拉的四种结果（与 iOS refreshSummaryToast 同一套判据）。 */
    static String refreshSummary(int attempted, int succeeded, int failed, boolean accountListUpdated) {
        if (failed > 0 && succeeded > 0) return LIST_UPDATED;
        if (failed > 0) return REFRESH_FAILED;
        if (attempted == 0) return REFRESH_UP_TO_DATE;
        return REFRESH_DONE;
    }

    /** 校验类文案（单号 / 手机尾号）不是 toast，由页面内联显示。 */
    static boolean isValidationMessage(String message) {
        String value = message == null ? "" : message;
        return value.contains("快递单号") || value.contains("手机尾号");
    }

    private ExpressToastCopy() {}
}
