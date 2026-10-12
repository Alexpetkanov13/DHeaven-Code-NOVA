use serde_json::Value;
use std::io::Write;
use std::sync::mpsc;

/// Serialized writer: all output goes through one thread so lines never interleave.
#[derive(Clone)]
pub struct Out(mpsc::Sender<Value>);

impl Out {
    pub fn stdout() -> Self {
        let (tx, rx) = mpsc::channel::<Value>();
        std::thread::spawn(move || {
            let mut so = std::io::stdout().lock();
            for v in rx {
                if writeln!(so, "{v}").and_then(|_| so.flush()).is_err() { break; }
            }
        });
        Out(tx)
    }
    #[cfg(test)]
    pub fn channel() -> (Self, mpsc::Receiver<Value>) { let (tx, rx) = mpsc::channel(); (Out(tx), rx) }
    pub fn send(&self, v: Value) { let _ = self.0.send(v); }
    pub fn notify(&self, method: &str, params: Value) { self.send(serde_json::json!({"method": method, "params": params})); }
}
