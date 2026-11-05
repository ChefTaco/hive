// The Hive ingress Caddy build: Caddy's own command with its standard modules, built from
// pinned module versions (go.mod and go.sum) so security fixes in its dependencies and the
// Go toolchain do not wait for an upstream Caddy release.
package main

import (
	caddycmd "github.com/caddyserver/caddy/v2/cmd"

	_ "github.com/caddyserver/caddy/v2/modules/standard"
)

func main() {
	caddycmd.Main()
}
