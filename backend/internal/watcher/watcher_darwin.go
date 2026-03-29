//go:build darwin

package watcher

import (
	"database/sql"
	"fmt"
	"log"
	"path/filepath"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/unix"

	"github.com/lambertse/windows-app-locktime/backend/internal/db"
	"github.com/lambertse/windows-app-locktime/backend/internal/engine"
)

// ─── platform hook: process enumeration ──────────────────────────────────────

// snapshotProcesses lists all running processes using sysctl (no cgo required).
func snapshotProcesses() ([]ProcessInfo, error) {
	kinfos, err := unix.SysctlKinfoProcSlice("kern.proc.all")
	if err != nil {
		return nil, fmt.Errorf("sysctl kern.proc.all: %w", err)
	}

	procs := make([]ProcessInfo, 0, len(kinfos))
	for _, ki := range kinfos {
		pid := ki.Proc.P_pid
		if pid <= 0 {
			continue
		}
		fullPath := exePathForPID(pid)
		if fullPath == "" {
			continue
		}
		procs = append(procs, ProcessInfo{
			PID:      int(pid),
			Name:     filepath.Base(fullPath),
			FullPath: fullPath,
		})
	}
	return procs, nil
}

// exePathForPID returns the full executable path for the given PID using the
// KERN_PROCARGS2 sysctl. The buffer format is: argc (int32, 4 bytes) followed
// by the null-terminated executable path.
func exePathForPID(pid int32) string {
	const (
		ctlKern       = 1  // CTL_KERN
		kernProcArgs2 = 49 // KERN_PROCARGS2
	)
	mib := [3]int32{ctlKern, kernProcArgs2, pid}

	// First call: determine required buffer size.
	n := uintptr(0)
	if _, _, errno := syscall.Syscall6(
		syscall.SYS___SYSCTL,
		uintptr(unsafe.Pointer(&mib[0])), 3,
		0, uintptr(unsafe.Pointer(&n)),
		0, 0,
	); errno != 0 || n == 0 {
		return ""
	}

	// Second call: read the data.
	buf := make([]byte, n)
	if _, _, errno := syscall.Syscall6(
		syscall.SYS___SYSCTL,
		uintptr(unsafe.Pointer(&mib[0])), 3,
		uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&n)),
		0, 0,
	); errno != 0 {
		return ""
	}

	// Skip argc (first 4 bytes), read null-terminated exec path.
	if len(buf) < 4 {
		return ""
	}
	data := buf[4:]
	for i, b := range data {
		if b == 0 {
			if i == 0 {
				return ""
			}
			return string(data[:i])
		}
	}
	return string(data)
}

// ─── platform hook: enforcement ───────────────────────────────────────────────

// enforceRule terminates proc with SIGTERM if the rule is currently locked.
// On macOS there is no pre-launch interception (no IFEO equivalent), so the
// watcher is the sole enforcement mechanism.
func enforceRule(rule db.Rule, proc *ProcessInfo, database *sql.DB, now time.Time) {
	minutes, _ := db.GetDailyMinutes(database, rule.ID, now.Format("2006-01-02"), now)
	rs, err := engine.ComputeRuleStatus(rule, minutes, now)
	if err != nil || rs.Status != "locked" {
		return
	}
	if err := unix.Kill(proc.PID, unix.SIGTERM); err != nil {
		log.Printf("watcher: enforce: kill pid %d (%s): %v", proc.PID, proc.Name, err)
		return
	}
	log.Printf("watcher: terminated blocked process %s (pid %d)", proc.Name, proc.PID)
}
