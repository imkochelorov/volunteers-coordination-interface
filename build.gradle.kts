plugins {
    kotlin("jvm") version "2.2.0"
    application
}
repositories { mavenCentral() }

dependencies {
    implementation("org.xerial:sqlite-jdbc:3.51.3.0")
    implementation("com.google.code.gson:gson:2.11.0")
    implementation("org.bouncycastle:bcprov-jdk18on:1.86")
    testImplementation("org.junit.jupiter:junit-jupiter:5.12.2")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher:1.12.2")
}

kotlin { compilerOptions { jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17) } }
java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}
application { mainClass.set("coordination.ServerKt") }

tasks.processResources {
    from("public") { into("public") }
}


tasks.test { useJUnitPlatform() }
