BUN ?= bun

.PHONY: install build run clean

install:
	$(BUN) install

build:
	$(BUN) run build

run: build
	$(BUN) run start

clean:
	rm -rf dist
