// What the Python and Go generators both read from the model: Caitlyn's traits, client-method
// naming (PROTOCOL.md section 10), result naming, SSE unions and their failure member, and versions.
val smithyVersion: String by project

dependencies {
    api("software.amazon.smithy:smithy-codegen-core:$smithyVersion")
    api("software.amazon.smithy:smithy-model:$smithyVersion")
    testImplementation(platform("org.junit:junit-bom:5.11.4"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test { useJUnitPlatform() }
