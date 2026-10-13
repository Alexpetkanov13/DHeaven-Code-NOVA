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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn greets_by_name() {
        println!("greeting NOVA");
        assert_eq!(greet("NOVA"), "Hello, NOVA!");
    }

    #[test]
    fn greets_all_with_prefix() {
        let g = Greeter { prefix: ">".into() };
        assert_eq!(g.greet_all(&["A"]), vec!["> Hello, A!".to_string()]);
    }

    #[test]
    #[ignore = "not implemented yet"]
    fn not_yet() {}

    #[test]
    fn deliberate_failure() {
        if std::env::var("NOVA_DEMO_FAIL").as_deref() == Ok("1") {
            assert_eq!(greet("NOVA"), "Hello, NOVA?", "set NOVA_DEMO_FAIL=1 to see a failure");
        }
    }
}
