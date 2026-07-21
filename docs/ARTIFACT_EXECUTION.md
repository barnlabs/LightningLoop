# Reviewed workspace artifact execution

Status: implementation contract for LightningLoop autonomous artifact mode

## Outcome

LightningLoop may turn an approved plan into real files only when the user explicitly selects a dedicated output directory and grants a bounded capability envelope for that run. Text-only delivery remains the default. The model never receives ambient host authority, a credential-bearing environment, or permission to alter an existing project implicitly.

## Capability envelope

Artifact mode grants only:

- creation and revision of bounded UTF-8 text files owned by the current run inside one dedicated output directory;
- integrity-pinned, harness-reviewed workflow inputs when a narrow built-in needs them, plus bounded binary outputs produced by approved sandboxed verification;
- optional execution of single-process structured verification commands from a fixed executable allowlist inside the existing OS sandbox on macOS;
- harness-selected bounded checks for Python and JavaScript syntax when the implementer did not declare a stronger check; multi-process build/test tools, including Cargo, fail closed because autonomous verifiers may not fork;
- localhost HTML proof and static picture capture only when the same execution grant is active;
- network denied, home-directory reads denied, writes outside the selected directory denied, credentials scrubbed, and `process-fork` denied in the composed macOS Seatbelt profile. Platforms without equivalent deterministic descendant containment do not run autonomous Bash verification;
- a finite file, byte, command, output, time, and review-round budget.

The selected directory must be new or empty. LightningLoop refuses `/`, the user home directory, symlinks, existing content, traversal, `.git`, credential-like paths, secret-shaped content, and files the run does not own. A run never deletes pre-existing data. Revisions may replace only files created earlier by that same run.

## Model protocol

When artifact mode is active, the implementer returns one structured object:

```json
{
  "deliverable": "human-readable summary",
  "notes": ["limitations"],
  "files": [{"path": "index.html", "content": "..."}],
  "verification_commands": [
    {"executable": "node", "arguments": ["--test"], "purpose": "Run the project tests"}
  ]
}
```

The harness, not the model, validates and writes the declared files. It records SHA-256, byte count, and relative path after each atomic write. Each repair round first reconciles the complete run-owned manifest: files omitted by the new round are unlinked without following links, while protected inputs and content not owned by the run are never deleted. The final report therefore cannot retain a stale, undeclared file from an earlier implementation. If the Evidence Lab is approved, the harness executes only structured command vectors plus its bounded language checks, captures provenance, duration, redacted output, and exit status, audits the resulting workspace, and hashes both declared and generated files. Implementer commands are supplementary. Supported behavior is encoded in the approved target as `js-export:<path>#<export>=<JSON scalar>`; a harness-owned runner imports that export, invokes it when callable, and emits the authoritative final assertion record. Syntax proves syntax only. Every verify-mode command is surrounded by exact manifests covering root realpath/device/inode/mode and each entry's path, type, POSIX mode, bytes, and content hash, so content replacement, type mutation, or `chmod` mutation rejects the proof. After model-review latency, the graph reopens the last passing report's exact manifest again immediately before any terminal award. The final audit independently rejects links, special files, unsafe writable modes, and mode changes to harness-written files. The only generate-mode exception is the exact integrity-pinned photo-relief tool/input pair, whose new outputs are subsequently audited and hashed. Shell syntax is not accepted as a command protocol. Executable allowlisting is only a product/protocol restriction. Deterministic descendant containment comes from replacing the pinned Sandbox Runtime profile's exact `process-fork` allow rule with a deny rule; if that composition contract changes, verification fails closed. PID/process-group tracking remains cleanup defense-in-depth, not the proof boundary.

For HTML, the harness exposes bounded bytes from an ephemeral `127.0.0.1` route, performs a real HTTP fetch and records status/content type/bytes/hash, closes the proof server, renders a PNG through macOS Quick Look, validates the PNG signature and size, and stores it under `_lightningloop/previews/`. The model cannot write to that reserved namespace. Supported generated PNG/JPEG/GIF/WebP files are signature-checked and added as picture evidence. Every reviewer image carries the expected SHA-256; immediately before encoding, the adapter rechecks the file type, byte bound, signature, and exact hash so a post-validation mutation aborts review. The native app displays those images only after rechecking the recorded SHA-256. It never embeds HTML: a user action starts a separate immutable, hash-bound, short-lived loopback server and opens its tokenized URL in the default browser. Every other reviewed file opens through its registered default application.

## Review invariant

The Gold Reviewer receives the harness-generated artifact report rather than the implementer's claim that files or tests exist. Gold additionally requires:

- every requested artifact operation passed;
- every executed verification command exited successfully;
- every required automatic check and preview capture passed;
- HTML proof contains a real loopback HTTP 200 response and a valid rendered PNG;
- the post-command workspace audit passed;
- the exact last-passing artifact manifest still matches when reopened after model review and immediately before terminal status;
- every acceptance criterion has a reviewer assessment tied to specific observed report evidence;
- the ordinary score, severity, required-change, round-cap, and deterministic evidence gates pass.

An unavailable sandbox, denied capability, malformed file manifest, command failure, secret detection, output overflow, timeout, or workspace-policy violation pauses the run. It never degrades silently to a text-only Gold result.

## Client contract

- **CLI:** explicit output-directory and approval flags; the effective capability envelope is printed before clarification.
- **TUI:** an explicit artifact command selects the directory and presents the grant before activation; status and final output distinguish text-only, artifact-write, and Evidence Lab modes and show preview/runner evidence.
- **Native GUI:** a directory picker, visible scope explanation, separate Evidence Lab toggle, hash-verified static picture gallery, localhost proof, script-runner trace, source inspection, and explicit default-app links. HTML is never embedded. Artifact mode is unavailable when the shared harness is not present.

## Residual risk

Sandboxed verification executes newly generated code in one process, and HTML picture capture invokes system Quick Look on generated content. Fork denial prevents verifier descendants but does not make the macOS sandbox or browser CSP a virtual machine, and it cannot prove the absence of every local side channel, renderer vulnerability, or resource-exhaustion technique. The feature therefore stays opt-in, confines writes, denies external network and ambient credentials, and applies hard time/output/file limits. Multi-process compilers and test runners are unsupported in autonomous verification and fail closed. The default browser may retain the tokenized URL in history and browser extensions may observe the page; the URL contains no file path and expires automatically. This is inappropriate for untrusted multi-tenant hosting.
