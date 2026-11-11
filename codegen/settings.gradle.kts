// Caitlyn's SDK generators, one Gradle build. Each is a smithy-build plugin; `smithy build` in
// codegen/ runs all four over the model (codegen/smithy-build.json).
rootProject.name = "caitlyn-codegen"
include("model-support", "typescript", "python", "go", "rust")
