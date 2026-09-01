# Assertion helpers for cake-autorate OpenWrt tests. Source from a test script.
TESTS_RUN=0
TESTS_FAILED=0

pass() { TESTS_RUN=$((TESTS_RUN + 1)); printf 'ok   - %s\n' "$1"; }

fail() {
	TESTS_RUN=$((TESTS_RUN + 1)); TESTS_FAILED=$((TESTS_FAILED + 1))
	printf 'FAIL - %s\n' "$1"
	[ -n "${2:-}" ] && printf '       %s\n' "$2"
}

assert_eq() { # name expected actual
	if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected: [$2] got: [$3]"; fi
}

assert_contains() { # name needle haystack
	case "$3" in *"$2"*) pass "$1" ;; *) fail "$1" "missing: [$2] in: [$3]" ;; esac
}

assert_not_contains() { # name needle haystack
	case "$3" in *"$2"*) fail "$1" "unexpected: [$2] in: [$3]" ;; *) pass "$1" ;; esac
}

report() {
	printf '%d tests, %d failed\n' "$TESTS_RUN" "$TESTS_FAILED"
	[ "$TESTS_FAILED" -eq 0 ]
}
