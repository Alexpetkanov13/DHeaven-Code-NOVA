plugins {
    application
}

repositories {
    mavenCentral()
}

dependencies {
    testImplementation(platform("org.junit:junit-bom:5.11.4"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test {
    useJUnitPlatform()
    // NOVA_DEMO_FAIL=1 enables GreeterTest.deliberateFailure (used by NOVA's E2E to see a real failure).
    environment("NOVA_DEMO_FAIL", System.getenv("NOVA_DEMO_FAIL") ?: "0")
    inputs.property("novaDemoFail", System.getenv("NOVA_DEMO_FAIL") ?: "0")
}

java {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
}

application {
    mainClass.set("com.dheaven.demo.App")
}

// Long-running task used by NOVA's E2E to exercise Kill (cancels the run and its process tree).
tasks.register("sleepDemo") {
    group = "demo"
    description = "Sleeps for 5 minutes (used to test cancel/kill)"
    doLast { Thread.sleep(300_000) }
}
