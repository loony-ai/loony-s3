# Testing

## Test scripts

All scripts live in `scripts/` and use only `curl` + `jq` (install `jq` if not present).

| Script                      | What it covers                                            |
| --------------------------- | --------------------------------------------------------- |
| `scripts/start-dev.sh`      | Start the server in dev mode (SQLite, port 8006)          |
| `scripts/test-all.sh`       | Run every test group in sequence                          |
| `scripts/test-auth.sh`      | Token issuance, JWT validation, API key auth              |
| `scripts/test-buckets.sh`   | Bucket CRUD, name validation, ACL                         |
| `scripts/test-objects.sh`   | Upload, download, range requests, TTL, versioning, delete |
| `scripts/test-presigned.sh` | Presigned URL generation and consumption                  |
| `scripts/test-multipart.sh` | Initiate, upload parts, complete, abort, list parts       |

## Running

```bash
# Terminal 1 — start server
./scripts/start-dev.sh

# Terminal 2 — run all tests
./scripts/test-all.sh

# Or individual groups
./scripts/test-objects.sh
```

Each script prints `✓ PASS` or `✗ FAIL` per test case and exits non-zero on failure.

## Environment

The scripts default to `BASE_URL=http://localhost:8006`. Override before running:

```bash
BASE_URL=http://staging.internal ./scripts/test-all.sh
```

## Manual curl examples

See [api.md](api.md) for full request/response documentation.

## Unit / integration tests

The project does not yet have a Rust `#[test]` suite — the shell scripts serve as the integration test harness. To add Rust tests:

```bash
cargo test
```

Tests can be added in each module with `#[cfg(test)]` blocks or in `tests/` at the crate root.
