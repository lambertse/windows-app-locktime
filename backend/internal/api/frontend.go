package api

import (
	"io/fs"
	"net/http"
	"os"
	"strings"

	"github.com/gin-gonic/gin"
)

// NewFrontendRouter returns a minimal gin engine that serves the SPA from
// distPath on disk (e.g. $INSTDIR\dist). API calls from the browser go
// directly to port 8089.
func NewFrontendRouter(distPath string) *gin.Engine {
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())
	RegisterSPACatchAll(r, os.DirFS(distPath))
	return r
}

// RegisterSPACatchAll serves the embedded React SPA. Static assets (JS, CSS,
// images, etc.) are served directly from the embedded FS; any other non-API
// path falls back to index.html so React Router handles client-side navigation.
//
// frontendFS must be an fs.FS rooted at the directory containing index.html
// (e.g. the embedded dist/ directory). If nil, the catch-all is skipped.
func RegisterSPACatchAll(r *gin.Engine, frontendFS fs.FS) {
	if frontendFS == nil {
		return
	}

	fileServer := http.FileServer(http.FS(frontendFS))

	r.NoRoute(func(c *gin.Context) {
		// API paths that weren't matched → 404 JSON, not the SPA.
		if strings.HasPrefix(c.Request.URL.Path, "/api/") {
			c.JSON(http.StatusNotFound, gin.H{"error": "not found"})
			return
		}

		// If the file exists in the embedded FS, serve it directly.
		// This covers /assets/*, /favicon.ico, etc.
		trimmed := strings.TrimPrefix(c.Request.URL.Path, "/")
		if trimmed != "" {
			if _, err := fs.Stat(frontendFS, trimmed); err == nil {
				fileServer.ServeHTTP(c.Writer, c.Request)
				return
			}
		}

		// Everything else → serve index.html so React Router can take over.
		c.FileFromFS("index.html", http.FS(frontendFS))
	})
}
