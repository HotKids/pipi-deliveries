import java.util.Properties

plugins {
    id("com.android.application")
}

val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.isFile) file.inputStream().use(::load)
}

fun localValue(environment: String, property: String): String =
    providers.environmentVariable(environment).orNull
        ?: localProperties.getProperty(property, "")

fun signingValue(name: String): String =
    providers.environmentVariable(name).orNull
        ?: providers.gradleProperty(name).orNull
        ?: ""

fun quoted(value: String): String = "\"" + value
    .replace("\\", "\\\\")
    .replace("\"", "\\\"") + "\""

fun localValueOrDefault(environment: String, property: String, fallback: String): String =
    localValue(environment, property).ifBlank { fallback }

val releaseVersionNameDefault = "1.2.3"
val releaseVersionName = providers.environmentVariable("DELIVERIES_VERSION_NAME")
    .orNull?.trim().orEmpty().ifBlank { releaseVersionNameDefault }
val releaseVersionCode = providers.environmentVariable("DELIVERIES_VERSION_CODE")
    .orNull?.toIntOrNull() ?: releaseVersionName.split('.').let { parts ->
        require(parts.size == 3 && parts.all { it.toIntOrNull() != null }) {
            "DELIVERIES_VERSION_NAME must use major.minor.patch"
        }
        parts[0].toInt() * 1_000_000 +
            parts[1].toInt() * 10_000 +
            parts[2].toInt() * 100 + 1
    }
val signingStore = signingValue("SIGNING_STORE_FILE")
val signingStorePassword = signingValue("SIGNING_STORE_PASSWORD")
val signingAlias = signingValue("SIGNING_KEY_ALIAS")
val signingKeyPassword = signingValue("SIGNING_KEY_PASSWORD")
val signingStoreFile = signingStore.takeIf(String::isNotBlank)?.let(rootProject::file)
val hasReleaseSigning = listOf(
    signingStore, signingStorePassword, signingAlias, signingKeyPassword
).all(String::isNotBlank) && signingStoreFile?.isFile == true

android {
    namespace = "me.pipi.deliveries"
    compileSdk = 37
    buildToolsVersion = "37.0.0"

    defaultConfig {
        applicationId = "me.pipi.deliveries"
        minSdk = 29
        targetSdk = 37
        versionCode = releaseVersionCode
        versionName = releaseVersionName
        buildConfigField(
            "String", "EXPRESS_GATEWAY_URL",
            quoted(localValueOrDefault(
                "DELIVERIES_EXPRESS_GATEWAY_URL",
                "deliveries.expressGatewayUrl",
                "https://pipi-gateway.hotki.de",
            )),
        )
        buildConfigField(
            "String", "EXPRESS_GATEWAY_TOKEN",
            quoted(localValue(
                "DELIVERIES_EXPRESS_GATEWAY_TOKEN",
                "deliveries.expressGatewayToken",
            ).ifBlank {
                // Backward-compatible with the existing local/CI Deliveries signing secret.
                localValue("DELIVERIES_K100_PROXY_TOKEN", "deliveries.k100ProxyToken")
            }),
        )
    }

    buildFeatures {
        buildConfig = true
    }

    flavorDimensions += "platform"
    productFlavors {
        create("standard") {
            dimension = "platform"
            minSdk = 31
        }
        create("compat") {
            dimension = "platform"
            minSdk = 29
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    val releaseSigning = if (hasReleaseSigning) signingConfigs.create("releaseKey") {
        storeFile = requireNotNull(signingStoreFile)
        storePassword = signingStorePassword
        keyAlias = signingAlias
        keyPassword = signingKeyPassword
    } else null

    buildTypes {
        debug {
            applicationIdSuffix = ""
        }
        release {
            signingConfig = releaseSigning ?: signingConfigs.getByName("debug")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    lint {
        warningsAsErrors = false
        checkReleaseBuilds = true
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.8.0")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.2.0")
    implementation("androidx.work:work-runtime:2.11.2")
    implementation("androidx.webkit:webkit:1.17.0")
    implementation("com.google.android.material:material:1.14.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20260814")
}
