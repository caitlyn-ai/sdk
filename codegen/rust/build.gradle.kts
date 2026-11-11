// Caitlyn's Rust client generator: a smithy-build plugin on Smithy's codegen framework.
dependencies {
    api(project(":model-support"))
    testImplementation(platform("org.junit:junit-bom:5.11.4"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test { useJUnitPlatform() }
