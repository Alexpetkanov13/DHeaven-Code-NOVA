plugins {
    application
}

repositories {
    mavenCentral()
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
