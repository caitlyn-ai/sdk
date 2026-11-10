// Shared settings for the generator projects. `gradle publish` writes every generator jar to
// codegen/build/repo, a file repository that codegen/smithy-build.json reads. Nothing is published remotely.
subprojects {
    apply(plugin = "java-library")
    apply(plugin = "maven-publish")

    group = "ai.caitlyn"
    version = "0.0.1"

    repositories { mavenCentral() }

    extensions.configure<JavaPluginExtension> {
        // The Smithy CLI bundles its own, newer Java runtime; 17 keeps the jars loadable by any of them.
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    tasks.withType<JavaCompile>().configureEach { options.compilerArgs.addAll(listOf("-Xlint:all", "-Werror")) }

    extensions.configure<PublishingExtension> {
        publications { create<MavenPublication>("maven") { from(components["java"]) } }
        repositories { maven { url = uri(rootProject.layout.buildDirectory.dir("repo")) } }
    }
}
