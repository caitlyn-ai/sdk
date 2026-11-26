// The Caitlyn CLI's generator: a smithy-build plugin that writes the CLI's command manifest, commands.json, from the
// same scope tree the SDKs use (model-support's ScopeTree). The CLI builds its command tree from the manifest, and the
// CLI reference docs are built from it too.
val smithyVersion: String by project

dependencies {
    api(project(":model-support"))
    testImplementation(platform("org.junit:junit-bom:5.11.4"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

tasks.test { useJUnitPlatform() }

// scripts/generate.sh: the manifest for a model file, written straight to cli/internal/spec/commands.json.
tasks.register<JavaExec>("commands") {
    classpath = sourceSets["main"].runtimeClasspath
    mainClass.set("ai.caitlyn.codegen.cli.CommandManifest")
}
