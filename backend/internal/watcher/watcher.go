//go:build windows

package watcher

import (
	"database/sql"
	"fmt"
	"log"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"

	"github.com/lambertse/windows-app-locktime/backend/internal/db"
)

// ─── platform hooks (called from watcher_common.go) ───────────────────────────

// snapshotProcesses delegates to the public Windows implementation.
func snapshotProcesses() ([]ProcessInfo, error) {
	return SnapshotProcesses()
}

// enforceRule is a no-op on Windows: IFEO + blocker.exe handles pre-launch blocking.
func enforceRule(_ db.Rule, _ *ProcessInfo, _ *sql.DB, _ time.Time) {}

// ─── Windows API: process enumeration ─────────────────────────────────────────

const (
	TH32CS_SNAPPROCESS                = 0x00000002
	PROCESS_ALL_ACCESS                = 0x1F0FFF
	PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
)

// PROCESSENTRY32 matches the Windows struct layout.
type PROCESSENTRY32 struct {
	Size            uint32
	CntUsage        uint32
	ProcessID       uint32
	DefaultHeapID   uintptr
	ModuleID        uint32
	CntThreads      uint32
	ParentProcessID uint32
	PriClassBase    int32
	Flags           uint32
	ExeFile         [260]uint16
}

var (
	kernel32                       = windows.NewLazySystemDLL("kernel32.dll")
	procCreateToolhelp32Snapshot   = kernel32.NewProc("CreateToolhelp32Snapshot")
	procProcess32FirstW            = kernel32.NewProc("Process32FirstW")
	procProcess32NextW             = kernel32.NewProc("Process32NextW")
	procQueryFullProcessImageNameW = kernel32.NewProc("QueryFullProcessImageNameW")
)

// SnapshotProcesses returns a list of currently running processes with full paths.
func SnapshotProcesses() ([]ProcessInfo, error) {
	handle, _, err := procCreateToolhelp32Snapshot.Call(TH32CS_SNAPPROCESS, 0)
	if handle == uintptr(windows.InvalidHandle) {
		return nil, fmt.Errorf("CreateToolhelp32Snapshot: %w", err)
	}
	defer windows.CloseHandle(windows.Handle(handle))

	var entry PROCESSENTRY32
	entry.Size = uint32(unsafe.Sizeof(entry))

	ret, _, err := procProcess32FirstW.Call(handle, uintptr(unsafe.Pointer(&entry)))
	if ret == 0 {
		return nil, fmt.Errorf("Process32FirstW: %w", err)
	}

	var procs []ProcessInfo
	for {
		name := windows.UTF16ToString(entry.ExeFile[:])
		fullPath := QueryFullProcessImageName(int(entry.ProcessID))
		procs = append(procs, ProcessInfo{
			PID:      int(entry.ProcessID),
			Name:     name,
			FullPath: fullPath,
		})
		ret, _, _ = procProcess32NextW.Call(handle, uintptr(unsafe.Pointer(&entry)))
		if ret == 0 {
			break
		}
	}
	return procs, nil
}

// QueryFullProcessImageName returns the full executable path for a process by PID.
func QueryFullProcessImageName(pid int) string {
	handle, err := windows.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(handle)

	var buf [windows.MAX_PATH]uint16
	size := uint32(len(buf))
	ret, _, _ := procQueryFullProcessImageNameW.Call(
		uintptr(handle),
		0,
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(unsafe.Pointer(&size)),
	)
	if ret == 0 {
		return ""
	}
	return windows.UTF16ToString(buf[:size])
}

// TerminateProcess forcibly kills a process by PID.
func TerminateProcess(pid int) error {
	handle, err := windows.OpenProcess(windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return fmt.Errorf("OpenProcess pid=%d: %w", pid, err)
	}
	defer windows.CloseHandle(handle)
	return windows.TerminateProcess(handle, 1)
}

// ─── IFEO registry management ─────────────────────────────────────────────────

const ifeoBase = `SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options`

// SetIFEO sets the Debugger key for exeName to point to blockerExePath.
func SetIFEO(exeName, blockerExePath string) error {
	if strings.EqualFold(filepath.Base(exeName), "blocker.exe") {
		return fmt.Errorf("refusing to register blocker.exe as IFEO target")
	}
	keyPath := ifeoBase + `\` + exeName
	k, _, err := registry.CreateKey(registry.LOCAL_MACHINE, keyPath, registry.SET_VALUE)
	if err != nil {
		return fmt.Errorf("CreateKey %s: %w", keyPath, err)
	}
	defer k.Close()
	return k.SetStringValue("Debugger", blockerExePath)
}

// ClearIFEO removes the Debugger value for exeName.
func ClearIFEO(exeName string) error {
	keyPath := ifeoBase + `\` + exeName
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, keyPath, registry.SET_VALUE)
	if err != nil {
		if err == registry.ErrNotExist {
			return nil
		}
		return fmt.Errorf("OpenKey %s: %w", keyPath, err)
	}
	defer k.Close()
	if err := k.DeleteValue("Debugger"); err != nil && err != registry.ErrNotExist {
		return fmt.Errorf("DeleteValue Debugger: %w", err)
	}
	return nil
}

// ReconcileIFEO ensures IFEO keys match the ifeo_active state in the DB.
func ReconcileIFEO(database *sql.DB, blockerExePath string) {
	rules, err := db.GetRules(database)
	if err != nil {
		log.Printf("ifeo reconcile: get rules: %v", err)
		return
	}
	for _, rule := range rules {
		if !rule.Enabled {
			if rule.IFEOActive {
				if err := ClearIFEO(rule.ExeName); err != nil {
					log.Printf("ifeo reconcile clear %s: %v", rule.ExeName, err)
				} else {
					_ = db.SetRuleIFEOActive(database, rule.ID, false)
				}
			}
			continue
		}
		if rule.IFEOActive {
			if err := SetIFEO(rule.ExeName, blockerExePath); err != nil {
				log.Printf("ifeo reconcile set %s: %v", rule.ExeName, err)
			}
		}
	}
}
