#!/usr/bin/env bash
# A globe with no data on it still builds, still deploys, and still renders — as a black sphere.
# Far better to learn that here than from the live site.
#
# The shared deploy workflow only checks that a bundle exists at all, so this is the worldtemp-
# specific half of that guard and runs as part of the build command.
set -euo pipefail

DIST="${1:-dist}"

test -f "$DIST/data/meta.json"
test -f "$DIST/geo/countries-110m.json"

months=$(ls "$DIST"/data/tavg_*.png | wc -l)
test "$months" -eq 12 || { echo "expected 12 monthly rasters, found $months"; exit 1; }
