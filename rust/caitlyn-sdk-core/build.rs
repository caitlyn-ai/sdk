// Records the compiler version for the user agent (PROTOCOL.md 3.1: lang/rust#<version>).
fn main() {
    let rustc = std::env::var("RUSTC").unwrap_or_else(|_| "rustc".into());
    let out = std::process::Command::new(rustc)
        .arg("--version")
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .unwrap_or_default();
    let version = out.split_whitespace().nth(1).unwrap_or("unknown");
    println!("cargo:rustc-env=CAITLYN_RUSTC_VERSION={version}");
    println!("cargo:rerun-if-env-changed=RUSTC");
}
