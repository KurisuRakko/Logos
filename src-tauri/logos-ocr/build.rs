// The prebuilt static ONNX Runtime for Windows always contains the DirectML provider, so the
// binary would import DirectML.dll / d3d12.dll / dxgi.dll at startup (DirectML by ordinal, which an
// older system copy may not match). Only the CPU provider is used, so delay-load them: they are
// never loaded at all. The app's build.rs does the same for the final executable; link args from
// this script only reach this crate's own examples and tests.
fn main() {
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.ends_with("windows-msvc") {
        for dll in ["DirectML.dll", "d3d12.dll", "dxgi.dll"] {
            println!("cargo:rustc-link-arg=/DELAYLOAD:{dll}");
        }
        println!("cargo:rustc-link-lib=delayimp");
    }
}
