#!/usr/bin/env bash
# Runs every openwrt/tests/test_*.sh. Exit status 1 if any test script fails.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
REPO_ROOT=$(cd ../.. && pwd)
export REPO_ROOT
rc=0
for t in test_*.sh
do
	printf '== %s\n' "${t}"
	bash "${t}" || rc=1
done
exit ${rc}
