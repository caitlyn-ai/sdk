// Caitlyn's smithy-typescript integration: our restJson protocol, our user agent, no AWS runtime.
val smithyTypeScriptVersion: String by project

dependencies {
    compileOnly("software.amazon.smithy.typescript:smithy-typescript-codegen:$smithyTypeScriptVersion")
}

dependencies {
    implementation(project(":model-support"))
}
