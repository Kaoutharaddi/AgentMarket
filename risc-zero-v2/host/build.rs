fn main() {
    risc0_build::embed_methods_with_options(
        std::collections::HashMap::from([(
            "agent_guest",
            risc0_build::GuestOptions::default(),
        )])
    );
}
