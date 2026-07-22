fn main() {
    println!("cargo:rerun-if-changed=icons/icon.ico");
    println!("cargo:rerun-if-changed=tauri.conf.json");
    println!("cargo:rerun-if-changed=resources/skills");
    println!("cargo:rerun-if-changed=../dist");
    tauri_build::build()
}
