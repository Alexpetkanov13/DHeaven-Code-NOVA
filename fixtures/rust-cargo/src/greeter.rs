/// Builds the greeting shown by NOVA fixtures.
pub fn greet(name: &str) -> String {
    format!("Hello, {name}!")
}

pub struct Greeter {
    pub prefix: String,
}

impl Greeter {
    pub fn greet_all(&self, names: &[&str]) -> Vec<String> {
        names.iter().map(|n| format!("{} {}", self.prefix, greet(n))).collect()
    }
}
