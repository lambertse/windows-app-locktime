package frontend

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var files embed.FS

// FS returns an fs.FS rooted at the embedded dist directory.
func FS() fs.FS {
	sub, err := fs.Sub(files, "dist")
	if err != nil {
		panic(err)
	}
	return sub
}
