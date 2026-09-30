import org.jetbrains.kotlin.gradle.dsl.KotlinVersion

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.4.20"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = "dev.obrigado"
version = providers.gradleProperty("pluginVersion").get()

repositories {
    mavenCentral()
    intellijPlatform {
        defaultRepositories()
    }
}

dependencies {
    intellijPlatform {
        // 2025.1 predates the unified IntelliJ IDEA distribution, so it is still published as
        // Community — which is also the smaller download for a plugin that needs no Ultimate API.
        intellijIdeaCommunity(providers.gradleProperty("platformVersion"))
        pluginVerifier()
        zipSigner()
    }

    testImplementation(platform("org.junit:junit-bom:6.1.3"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
    // Not for any test here: the platform's own test listener, which the IntelliJ Platform
    // Gradle Plugin puts on every test classpath, links JUnit 4 classes (IJPL-157292). Without
    // this the test JVM cannot start at all.
    testRuntimeOnly("junit:junit:4.13.2")
}

kotlin {
    jvmToolchain(21)
    compilerOptions {
        // The IDE supplies the standard library at runtime, and 2025.1 bundles 2.1. Compiling
        // against a newer API would link calls that the oldest supported IDE cannot resolve.
        // The LANGUAGE version can be newer — 2.1 is deprecated in this compiler — because any
        // language feature that needs a newer library is refused at API version 2.1. The
        // compiler still warns that API version 2.1 is deprecated; that warning goes when the
        // oldest supported IDE is one bundling 2.2, which is 2025.3 (build 253).
        apiVersion.set(KotlinVersion.KOTLIN_2_1)
        languageVersion.set(KotlinVersion.KOTLIN_2_2)
    }
}

intellijPlatform {
    pluginConfiguration {
        ideaVersion {
            sinceBuild = "251"
            // Open-ended. The plugin touches one documented extension point and a handful of
            // long-stable utilities; capping it would make every IDE release a forced update.
            untilBuild = provider { null }
        }
    }
    pluginVerification {
        ides {
            recommended()
        }
    }
}

tasks.test {
    useJUnitPlatform()
    // The Kotlin port of `@obrigado/surface` is held to the same vectors as the TypeScript one.
    val vectors = layout.projectDirectory.file("../surface/test/vectors.json")
    inputs.file(vectors)
    systemProperty("obrigado.vectors", vectors.asFile.absolutePath)
}
