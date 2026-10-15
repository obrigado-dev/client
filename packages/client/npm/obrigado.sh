#!/bin/sh
#
# obrigado, as npm installs it (A44). Published as `bin/obrigado` in @obrigado/client.
#
# @obrigado/client names one optional dependency per platform, @obrigado/client-darwin-arm64 and
# the rest, and each declares the `os`, `cpu` and `libc` it runs on, so npm, pnpm, bun or yarn
# installs the one that fits this machine. That package holds the release's binary, the same bytes
# install.sh fetches, which the release's signed SHA256SUMS describe. This finds it and runs it.
#
# A shell script and not a Node one: agents run `obrigado statusline` on every render, some with a
# PATH that has no node on it, and this costs a few milliseconds where starting Node costs tens.

# Back from the link the package manager put in its bin directory to this file.
self=$0
while [ -L "$self" ]; do
  link=$(readlink "$self") || break
  case $link in
    /*) self=$link ;;
    *)
      case $self in
        */*) self=${self%/*}/$link ;;
        *) self=$link ;;
      esac
      ;;
  esac
done
case $self in
  */*) here=${self%/*} ;;
  *) here=. ;;
esac
# This package's own directory with every link resolved: pnpm links it in from its store, where the
# platform packages sit beside it.
package=$(cd -P "$here/.." && pwd -P) || exit 1

# npm nests the platform package inside this one; pnpm, bun and yarn put it beside it.
nested=$package/node_modules/@obrigado
beside=${package%/*}

found=
count=0
for binary in "$nested"/client-*/bin/obrigado "$beside"/client-*/bin/obrigado; do
  [ -f "$binary" ] || continue
  [ -n "$found" ] || found=$binary
  count=$((count + 1))
done

# More than one only where a package manager ignores `libc` and installs both Linux x64 builds, or
# was told to install for other platforms too. This machine's, chosen the way install.sh chooses.
if [ "$count" -gt 1 ]; then
  case "$(uname -s) $(uname -m)" in
    "Darwin arm64") want=darwin-arm64 ;;
    "Darwin x86_64") want=darwin-x64 ;;
    "Linux aarch64" | "Linux arm64") want=linux-arm64 ;;
    "Linux x86_64")
      # Bun's glibc build does not fail to start on musl, it segfaults partway through.
      if (ldd --version 2>&1 || true) | grep -qi musl; then
        want=linux-x64-musl
      else
        want=linux-x64
      fi
      ;;
    *) want= ;;
  esac
  if [ -n "$want" ]; then
    for binary in "$nested/client-$want/bin/obrigado" "$beside/client-$want/bin/obrigado"; do
      if [ -f "$binary" ]; then
        found=$binary
        break
      fi
    done
  fi
fi

# On musl there is a build for x64 only. A package manager that ignores `libc` installs the glibc
# arm64 build there anyway, as yarn 1 does on Alpine, and it cannot start without glibc's loader.
if [ -e /lib/ld-musl-aarch64.so.1 ] && [ ! -e /lib/ld-linux-aarch64.so.1 ]; then
  case $found in
    */client-linux-arm64/bin/obrigado) found= ;;
  esac
fi

if [ -z "$found" ]; then
  system="$(uname -s) $(uname -m)"
  for loader in /lib/ld-musl-*.so.1; do
    [ -e "$loader" ] && system="$system with musl"
    break
  done
  printf 'obrigado: @obrigado/client has no build for %s. It has builds for macOS and glibc Linux on arm64 and x64, and musl Linux on x64: https://obrigado.dev\n' \
    "$system" >&2
  exit 1
fi
exec "$found" "$@"
