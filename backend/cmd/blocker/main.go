//go:build windows

package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	checkURL   = "http://127.0.0.1:8089/api/v1/check"
	MB_OK      = 0x00000000
	MB_ICONERR = 0x00000010
)

var (
	user32      = windows.NewLazySystemDLL("user32.dll")
	messageBoxW = user32.NewProc("MessageBoxW")
)

type checkResponse struct {
	Allowed      bool    `json:"allowed"`
	RuleID       *string `json:"rule_id"`
	RuleName     *string `json:"rule_name"`
	Reason       *string `json:"reason"`
	NextUnlockAt *string `json:"next_unlock_at"`
}

func main() {
	// Windows calls: blocker.exe <target_exe_path> [original args...]
	if len(os.Args) < 2 {
		// No target — nothing to do
		os.Exit(0)
	}

	targetExe := os.Args[1]
	targetArgs := os.Args[2:]

	// Query locktime service
	resp, err := checkAccess(targetExe)
	if err != nil {
		// Service unavailable — FAIL OPEN: launch the target
		launchTarget(targetExe, targetArgs)
		return
	}

	if resp.Allowed {
		// Allowed — launch target
		launchTarget(targetExe, targetArgs)
		return
	}

	// Blocked — show dialog
	ruleName := "this application"
	if resp.RuleName != nil {
		ruleName = *resp.RuleName
	}

	nextUnlock := "no scheduled time"
	if resp.NextUnlockAt != nil && *resp.NextUnlockAt != "" {
		nextUnlock = *resp.NextUnlockAt
	}

	msg := fmt.Sprintf("AppLocker: %s is blocked until %s.", ruleName, nextUnlock)
	showMessageBox("AppLocker — Access Blocked", msg)
	os.Exit(0)
}

func checkAccess(exePath string) (*checkResponse, error) {
	reqURL := checkURL + "?exe_path=" + url.QueryEscape(exePath)
	resp, err := http.Get(reqURL) //nolint:gosec
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("check returned HTTP %d", resp.StatusCode)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	var cr checkResponse
	if err := json.Unmarshal(body, &cr); err != nil {
		return nil, err
	}
	return &cr, nil
}

// launchTarget re-executes the original target with its original arguments.
// This replaces the blocker process — IFEO Debugger flow expects the target to run after.
func launchTarget(exe string, args []string) {
	// Build argv[0] exe + remaining args
	var cmdLine strings.Builder
	cmdLine.WriteString(`"`)
	cmdLine.WriteString(exe)
	cmdLine.WriteString(`"`)
	for _, a := range args {
		cmdLine.WriteString(` "`)
		cmdLine.WriteString(a)
		cmdLine.WriteString(`"`)
	}

	cmdLineUTF16, _ := syscall.UTF16PtrFromString(cmdLine.String())
	exeUTF16, _ := syscall.UTF16PtrFromString(exe)

	var si syscall.StartupInfo
	var pi syscall.ProcessInformation
	si.Cb = uint32(unsafe.Sizeof(si))

	err := syscall.CreateProcess(
		exeUTF16,
		cmdLineUTF16,
		nil, nil, false, 0, nil, nil,
		&si, &pi)
	if err != nil {
		showMessageBox("AppLocker Error", fmt.Sprintf("Failed to launch %s: %v", exe, err))
		os.Exit(1)
	}

	syscall.CloseHandle(pi.Thread)
	syscall.CloseHandle(pi.Process)
	os.Exit(0)
}

func showMessageBox(title, message string) {
	titleUTF16, _ := syscall.UTF16PtrFromString(title)
	msgUTF16, _ := syscall.UTF16PtrFromString(message)
	messageBoxW.Call(
		0,
		uintptr(unsafe.Pointer(msgUTF16)),
		uintptr(unsafe.Pointer(titleUTF16)),
		MB_OK|MB_ICONERR,
	)
}
