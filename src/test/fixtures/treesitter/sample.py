class Greeter:
    def hello(self, name: str) -> str:
        return f"Привет {name}"


def main() -> None:
    print(Greeter().hello("мир"))
