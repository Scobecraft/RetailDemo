import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
}

val keystoreProps = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

android {
    namespace = "de.retaildemo.admin"
    compileSdk = 36

    defaultConfig {
        applicationId = "de.retaildemo.admin"
        minSdk = 26
        targetSdk = 36
        versionCode = 7
        versionName = "1.6.0"
    }

    signingConfigs {
        create("release") {
            // Updates lassen sich nur mit DEMSELBEN Schlüssel über die alte Version installieren.
            // Ohne Schlüssel lieber abbrechen als eine inkompatible APK bauen.
            val wantsRelease = gradle.startParameter.taskNames.any { it.contains("Release", ignoreCase = true) }
            if (keystoreProps.isEmpty() && wantsRelease) {
                throw GradleException(
                    "Signaturschlüssel fehlt: keystore/release.jks und keystore.properties " +
                        "(aus RetailDemo-Signaturschluessel.zip) in den Ordner android/ entpacken."
                )
            }
            if (keystoreProps.isNotEmpty()) {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }

dependencies {
    implementation(project(":core"))
    implementation(libs.core.ktx)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.material3)
    implementation(libs.coil.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.compose.icons)
}
