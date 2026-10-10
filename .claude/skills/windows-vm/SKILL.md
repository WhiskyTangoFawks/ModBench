---
name: windows-vm
description: The Windows 11 test VM on a Linux host. Use to run a command or the gates on Windows, or to start, stop or rebuild the VM.
---

# Windows VM

A Windows 11 guest runs in Docker through [dockur/windows](https://github.com/dockur/windows). The host needs Docker and `/dev/kvm`. The VM's disk, SSH key and known hosts live in `~/.local/share/modbench-windows`, or in `$MODBENCH_WINDOWS_HOME` when it is set.

## Lifecycle

- `vm.sh up` starts the VM, waits for SSH and installs the toolchain with `provision.ps1`, which is idempotent. On the first run it downloads Windows and installs it unattended, about 30 minutes. The install ends with `oem/install.ps1`, which opens SSH and nothing more. Its log is `C:\OEM\install.log`.
- `vm.sh ssh <command>` runs a PowerShell command in the VM as an administrator. `vm.sh run <script.ps1> [args]` copies a script into the VM and runs it. PowerShell reads a multi-line script from stdin one line at a time, so a piped script breaks.
- `vm.sh down` stops the VM. The disk stays. Delete `disk/` to rebuild Windows from nothing.
- `vm.sh screen [file.png]` saves a screenshot of the VM's display, default `/tmp/modbench-windows.png`. http://127.0.0.1:8006 shows it live.

## Gates

`gates.sh` runs root CLAUDE.md's Tools commands natively in the VM, in PowerShell, against this worktree with its uncommitted files. It prints `All Windows gates passed` or the gates that failed, and exits non-zero on a failure. The comment and diagram gates stay on Linux: they read text, the same on every platform.

`vm.sh sync` copies the worktree to `C:\work\modbench` alone, for a narrower run: `vm.sh ssh 'cd C:\work\modbench\MEditService; dotnet test <project> --filter <name>'`. Dependencies and build output stay in the VM between syncs.

A command over SSH runs in session 0, which has no desktop. The VM signs `modbench` in to the console, session 1.

A shell that started before its user joined the `docker` group gets permission denied from `docker`. Run `sg docker -c 'bash vm.sh up'` there.
