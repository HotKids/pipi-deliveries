# 构建说明

本项目是标准 Android Gradle 项目，不需要 apktool、外置签名器或仓库内的
keystore。构建环境使用 JDK 21；Java 源码兼容级别为 17。Android SDK 需包含
API 37 与 Build Tools 37.0.0。

## 常用命令

- `./build.sh` 或 `./build.sh beta`：使用项目唯一签名构建下一版本的 beta APK，
  并固定接入 beta Worker；这是本地构建的默认入口；
- `./build.sh debug`：构建 Android 12 及以上版本的 debug APK；
- `./build.sh compat`：构建 Android 10 及以上版本的兼容 debug APK；
- `./build.sh check`：运行两个 product flavor 的单元测试、lint 及 debug/release 构建；
- `./build.sh release`：仅在明确发布正式版时运行，生成两个正式版 APK；
- `./gradlew :app:testStandardDebugUnitTest :app:testCompatDebugUnitTest`：仅运行单元测试。

标准包使用 `standard` flavor（最低 Android 12），兼容包使用 `compat` flavor（最低
Android 10）。两者使用相同包名与签名。release 产物复制至 `dist/Pipi-Deliveries.apk`
和 `dist/Pipi-Deliveries-Android10.apk`。
beta 产物复制至 `dist/Pipi-Deliveries-beta.apk` 和
`dist/Pipi-Deliveries-beta-Android10.apk`，不会覆盖正式版产物。

## 本地配置

网关地址优先读取环境变量，其次读取仓库根目录中未纳入版本控制的
`local.properties`：

- `DELIVERIES_EXPRESS_GATEWAY_URL` / `deliveries.expressGatewayUrl`；
- `DELIVERIES_VERSION_NAME` 与 `DELIVERIES_VERSION_CODE` 仅可通过环境变量覆盖构建版本。

Android 使用 Android Keystore 硬件证明建立网关会话，并以应用私钥生成
`X-Pipi-*` 请求签名。APK 不读取、内置或保存用户 Access Key，也不需要共享网关密钥。

配置项仅填写到本机环境或 `local.properties`，不得提交真实凭据。
在 Git worktree 中构建时，`build.sh` 会自动复用同一仓库其他工作树中的
`local.properties`；也可通过 `DELIVERIES_LOCAL_PROPERTIES_FILE` 显式指定配置文件。
构建过程只向 Gradle 传递文件路径，不复制或输出配置内容。

## 正式签名

Gradle 从环境变量或用户级 `~/.gradle/gradle.properties` 读取以下签名配置：

- `SIGNING_STORE_FILE`；
- `SIGNING_STORE_PASSWORD`；
- `SIGNING_KEY_ALIAS`；
- `SIGNING_KEY_PASSWORD`。

macOS 上的 `build.sh` 会在未显式设置密码时，从系统钥匙串中读取
`pipi-deliveries-release-store` 与 `pipi-deliveries-release-key`。凭据缺失时，本地
release 构建会直接失败，不会回退到 debug 签名。

GitHub Actions 使用 `SIGNING_KEYSTORE_BASE64`、`SIGNING_STORE_PASSWORD`、
`SIGNING_KEY_ALIAS` 与 `SIGNING_KEY_PASSWORD` 四个 Repository Secret，临时还原
keystore 后构建签名 APK，并在任务结束时删除临时文件。
