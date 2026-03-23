//go:build !windows

package api

// getProcessList returns an empty list on non-Windows platforms.
func getProcessList() []map[string]interface{} {
	return []map[string]interface{}{}
}

// showFileBrowseDialog is a no-op stub on non-Windows platforms.
func showFileBrowseDialog(filter string) (*string, bool, error) {
	cancelled := true
	return nil, cancelled, nil
}
