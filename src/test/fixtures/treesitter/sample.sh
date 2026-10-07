#!/usr/bin/env bash

greet() {
  echo "привет $1"
}

main() {
  greet "мир"
}

main "$@"
