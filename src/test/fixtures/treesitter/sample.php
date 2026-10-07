<?php

class Greeter {
  public function hello(string $name): string {
    return "привет $name";
  }
}

function main(): void {
  echo (new Greeter())->hello("мир");
}
