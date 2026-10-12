package me.pipi.deliveries.network;

/**
 * 用户 2026-09-27 提交前核对答复四（同步轮里单个请求自身超时「四端对齐 iOS」，与 iOS recognizeNonSyncCarrier 同一语义）：a
 * recognition request a sync round was waiting for ended on a time limit of its own — a connect or read timeout, or the
 * shared request's own budget — before any answer. Nothing was recorded for the waybill: no failure, no cooldown, no
 * terminal verdict. The round marks it cut off, so it goes last in the next round. Outside a sync round such a timeout
 * records nothing either (用户 2026-09-27 提交前核对答复五，「四端都不算失败（对齐 iOS）」), but the caller sees the
 * network failure it saw before and nothing is marked.
 */
public final class CarrierRecognitionTimeoutException extends Exception {
    public CarrierRecognitionTimeoutException() {
        super("carrier recognition request timed out");
    }
}
