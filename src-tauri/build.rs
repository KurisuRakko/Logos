fn main() {
    // See logos-ocr/build.rs: ONNX Runtime's DirectML provider is never used, so its DLLs are
    // delay-loaded and never actually loaded
    let target = std::env::var("TARGET").unwrap_or_default();
    if target.ends_with("windows-msvc") {
        for dll in ["DirectML.dll", "d3d12.dll", "dxgi.dll"] {
            println!("cargo:rustc-link-arg=/DELAYLOAD:{dll}");
        }
        println!("cargo:rustc-link-lib=delayimp");
    }
    tauri_build::build()
}
