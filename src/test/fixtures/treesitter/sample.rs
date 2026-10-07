pub struct Counter {
    value: i32,
}

impl Counter {
    pub fn new() -> Self {
        Self { value: 0 }
    }

    pub fn inc(&mut self) {
        self.value += 1;
    }
}

pub fn make_counter() -> Counter {
    Counter::new()
}
