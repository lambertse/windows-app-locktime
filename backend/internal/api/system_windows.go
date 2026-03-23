//go:build windows

package api

import (
	"runtime"
	"unsafe"

	"github.com/go-ole/go-ole"
	"golang.org/x/sys/windows"

	"github.com/lambertse/windows-app-locktime/backend/internal/watcher"
)

type filePickerRequest struct {
	Filter string
	resp   chan filePickerResponse
}

type filePickerResponse struct {
	Path      *string
	Cancelled bool
	Err       error
}

var filePickerCh = make(chan filePickerRequest, 1)

func init() {
	go func() {
		runtime.LockOSThread()
		ole.CoInitializeEx(0, ole.COINIT_APARTMENTTHREADED)
		defer ole.CoUninitialize()

		for req := range filePickerCh {
			path, cancelled, err := showOpenFileDialogSTA(req.Filter)
			req.resp <- filePickerResponse{Path: path, Cancelled: cancelled, Err: err}
		}
	}()
}

func showFileBrowseDialog(filter string) (*string, bool, error) {
	req := filePickerRequest{
		Filter: filter,
		resp:   make(chan filePickerResponse, 1),
	}
	filePickerCh <- req
	resp := <-req.resp
	return resp.Path, resp.Cancelled, resp.Err
}

// OPENFILENAMEW mirrors the Windows OPENFILENAMEW struct.
type OPENFILENAMEW struct {
	lStructSize       uint32
	hwndOwner         uintptr
	hInstance         uintptr
	lpstrFilter       *uint16
	lpstrCustomFilter *uint16
	nMaxCustFilter    uint32
	nFilterIndex      uint32
	lpstrFile         *uint16
	nMaxFile          uint32
	lpstrFileTitle    *uint16
	nMaxFileTitle     uint32
	lpstrInitialDir   *uint16
	lpstrTitle        *uint16
	Flags             uint32
	nFileOffset       uint16
	nFileExtension    uint16
	lpstrDefExt       *uint16
	lCustData         uintptr
	lpfnHook          uintptr
	lpTemplateName    *uint16
	pvReserved        uintptr
	dwReserved        uint32
	FlagsEx           uint32
}

var (
	comdlg32        = windows.NewLazySystemDLL("comdlg32.dll")
	getOpenFileNameW = comdlg32.NewProc("GetOpenFileNameW")
)

func showOpenFileDialogSTA(filter string) (*string, bool, error) {
	// Convert filter string (pipe-separated) to double-null terminated UTF-16
	filterUTF16 := make([]uint16, 0, 256)
	for _, ch := range filter {
		if ch == '|' {
			filterUTF16 = append(filterUTF16, 0)
		} else {
			filterUTF16 = append(filterUTF16, uint16(ch))
		}
	}
	filterUTF16 = append(filterUTF16, 0, 0)

	var fileBuf [windows.MAX_PATH]uint16

	ofn := OPENFILENAMEW{
		lStructSize: uint32(unsafe.Sizeof(OPENFILENAMEW{})),
		lpstrFilter: &filterUTF16[0],
		lpstrFile:   &fileBuf[0],
		nMaxFile:    windows.MAX_PATH,
		Flags:       0x00000004 | 0x00000800 | 0x00001000, // OFN_NOCHANGEDIR | OFN_PATHMUSTEXIST | OFN_FILEMUSTEXIST
	}

	ret, _, _ := getOpenFileNameW.Call(uintptr(unsafe.Pointer(&ofn)))
	if ret == 0 {
		// User cancelled
		cancelled := true
		return nil, cancelled, nil
	}

	path := windows.UTF16ToString(fileBuf[:])
	return &path, false, nil
}

func getProcessList() []map[string]interface{} {
	procs, err := watcher.SnapshotProcesses()
	if err != nil {
		return nil
	}
	var result []map[string]interface{}
	for _, p := range procs {
		result = append(result, map[string]interface{}{
			"pid":       p.PID,
			"name":      p.Name,
			"full_path": p.FullPath,
		})
	}
	return result
}
