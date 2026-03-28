//go:build windows

package service

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// nginxConfTemplate is the nginx configuration for the frontend SPA server.
// DIST_PATH is replaced at runtime with the actual path to the frontend dist
// directory. nginx serves static files directly and falls back to index.html
// for client-side routing. API calls are proxied to the Go API on port 8089.
const nginxConfTemplate = `worker_processes 1;
pid logs/nginx.pid;
error_log logs/error.log warn;

events {
    worker_connections 64;
}

http {
    include       conf/mime.types;
    default_type  application/octet-stream;
    sendfile      on;

    server {
        listen      127.0.0.1:8090;
        server_name localhost;

        root        DIST_PATH;
        index       index.html;

        location /api/ {
            proxy_pass       http://127.0.0.1:8089;
            proxy_set_header Host $host;
        }

        location / {
            try_files $uri $uri/ /index.html;
        }
    }
}
`

// writeNginxConf writes nginx.conf into nginxDir/conf/ with the real dist path.
func writeNginxConf(nginxDir, distPath string) error {
	// nginx requires forward slashes even on Windows.
	distPathFwd := strings.ReplaceAll(distPath, `\`, `/`)
	conf := strings.ReplaceAll(nginxConfTemplate, "DIST_PATH", distPathFwd)

	if err := os.MkdirAll(filepath.Join(nginxDir, "conf"), 0750); err != nil {
		return fmt.Errorf("create nginx conf dir: %w", err)
	}
	if err := os.MkdirAll(filepath.Join(nginxDir, "logs"), 0750); err != nil {
		return fmt.Errorf("create nginx logs dir: %w", err)
	}
	confPath := filepath.Join(nginxDir, "conf", "nginx.conf")
	return os.WriteFile(confPath, []byte(conf), 0644)
}

// startNginx writes nginx.conf and starts nginx.exe as a background process.
// Returns the process handle used later to stop nginx.
func startNginx(nginxDir, distPath string) (*os.Process, error) {
	nginxExe := filepath.Join(nginxDir, "nginx.exe")
	if _, err := os.Stat(nginxExe); err != nil {
		return nil, fmt.Errorf("nginx.exe not found at %s: %w", nginxExe, err)
	}

	if err := writeNginxConf(nginxDir, distPath); err != nil {
		return nil, fmt.Errorf("write nginx.conf: %w", err)
	}

	cmd := exec.Command(nginxExe)
	cmd.Dir = nginxDir
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("exec nginx: %w", err)
	}

	// Brief pause so nginx can bind the port before we report success.
	time.Sleep(300 * time.Millisecond)

	log.Printf("service: nginx started (pid %d) serving %s on %s", cmd.Process.Pid, distPath, FrontendAddr)
	return cmd.Process, nil
}

// stopNginx sends a graceful quit signal to nginx; kills the process if that fails.
func stopNginx(proc *os.Process, nginxDir string) {
	if proc == nil {
		return
	}
	nginxExe := filepath.Join(nginxDir, "nginx.exe")
	quit := exec.Command(nginxExe, "-s", "quit")
	quit.Dir = nginxDir
	if err := quit.Run(); err != nil {
		log.Printf("service: nginx -s quit failed (%v), killing process", err)
		_ = proc.Kill()
		return
	}
	log.Printf("service: nginx stopped")
}
