.PHONY: build-windows build-macos test clean tidy installer

GOOS     = windows
GOARCH   = amd64
CGO_ENABLED = 0
LDFLAGS  = -s -w -H windowsgui

DIST     = dist

build-windows:
	@mkdir -p $(DIST)
	GOOS=$(GOOS) GOARCH=$(GOARCH) CGO_ENABLED=$(CGO_ENABLED) \
		go build -ldflags="$(LDFLAGS)" -o $(DIST)/locktime-svc.exe ./cmd/locktime-svc
	GOOS=$(GOOS) GOARCH=$(GOARCH) CGO_ENABLED=$(CGO_ENABLED) \
		go build -ldflags="$(LDFLAGS)" -o $(DIST)/blocker.exe ./cmd/blocker
	@echo "Built: $(DIST)/locktime-svc.exe  $(DIST)/blocker.exe"

build-macos:
	@mkdir -p $(DIST)
	GOOS=darwin GOARCH=arm64 CGO_ENABLED=0 \
		go build -ldflags="-s -w" -o $(DIST)/locktime-svc ./cmd/locktime-svc
	@echo "Built: $(DIST)/locktime-svc"

# Run tests on the host (Linux/macOS — engine tests are platform-neutral)
test:
	go test ./internal/engine/... -v

# Run all tests with coverage
test-cover:
	go test ./internal/engine/... -v -coverprofile=coverage.out
	go tool cover -html=coverage.out -o coverage.html
	@echo "Coverage report: coverage.html"

tidy:
	go mod tidy

clean:
	rm -rf $(DIST)

installer: build-windows
	@mkdir -p ../installer
	cp $(DIST)/locktime-svc.exe ../installer/
	cp $(DIST)/blocker.exe ../installer/
	cd .. && makensis installer/locktime.nsi
	@echo "Installer: installer/locktime-installer.exe"
