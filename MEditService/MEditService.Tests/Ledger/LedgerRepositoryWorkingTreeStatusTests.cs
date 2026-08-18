using MEditService.Core.Ledger;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Ledger;

/// <summary>
/// #368 review (mutation axis, optional item): <see cref="LedgerRepository.WorkingTreeStatus"/>'s
/// crash-recovery fallback — reading the index status column when the working-tree column is blank
/// — had no direct coverage. Real git throughout, cheap to construct with the same primitives every
/// other Ledger/ test already uses.
/// </summary>
public sealed class LedgerRepositoryWorkingTreeStatusTests
{
    [Fact]
    public void StagedButUncommittedEdit_FallsBackToTheIndexStatusColumn()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-ledger-repo-status-").FullName;
        var originFolder = Directory.CreateTempSubdirectory("medit-origin-staged-").FullName;
        try
        {
            var ledger = new LedgerRepository(new LedgerOptions(ledgerRoot), NullLogger<LedgerRepository>.Instance);
            var relativePath = LedgerRecordPath.For("Vendor.esp", "npc_", "000800:Vendor.esp");
            var absolutePath = Path.Combine(originFolder, relativePath);

            ledger.EnsureRepo(originFolder);
            Directory.CreateDirectory(Path.GetDirectoryName(absolutePath)!);
            File.WriteAllText(absolutePath, "FormKey: 000800:Vendor.esp\n");
            ledger.StagePath(originFolder, relativePath);
            ledger.CommitStaged(originFolder, "vendor: test fixture");

            // Edit, then stage the edit — and stop there. The working tree now matches the index
            // exactly (nothing further to show in the worktree column), but the index still differs
            // from HEAD (the baseline commit above) — the exact "stray staged entry" shape
            // LedgerRepository's own class remarks describe as the crash-recovery case
            // ResetIndexToHead exists to clean up, caught here mid-flight instead of after a crash.
            File.WriteAllText(absolutePath, "FormKey: 000800:Vendor.esp\nAggression: Frenzied\n");
            ledger.StagePath(originFolder, relativePath);

            var status = ledger.WorkingTreeStatus(originFolder);

            var (code, path) = Assert.Single(status);
            Assert.Equal('M', code);
            Assert.Equal(relativePath, path);
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(originFolder, recursive: true);
        }
    }

    // Suite-axis review, #393: under -z, a rename entry carries its origin path as a *second*
    // NUL-terminated field, which the parser must consume or the field is misread as the next
    // entry's own status line. Legal, reachable input — the crash shape TryStageRenumberAsync
    // leaves (old path's removal and new path's add both staged, process dies before commit) is
    // exactly a rename-shaped staged pair once git's rename inference joins the two — so the
    // consumption is a requirement of #368's status parsing plus this class's own crash-recovery
    // contract, not defensive decoration. Pins the `||` in the R/C check: mutated to `&&`, a
    // staged-side-only rename leaves the origin path queued and the entry *after* the rename
    // comes back as garbage (verified red by applying that exact mutant before landing this).
    [Fact]
    public void RenameShapedStagedPair_DoesNotCorruptTheEntryAfterIt()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-ledger-repo-rename-").FullName;
        var originFolder = Directory.CreateTempSubdirectory("medit-origin-rename-").FullName;
        try
        {
            var ledger = new LedgerRepository(new LedgerOptions(ledgerRoot), NullLogger<LedgerRepository>.Instance);
            var oldPath = LedgerRecordPath.For("Vendor.esp", "npc_", "000800:Vendor.esp");
            var newPath = LedgerRecordPath.For("Vendor.esp", "npc_", "000900:Vendor.esp");
            var laterPath = LedgerRecordPath.For("Vendor.esp", "npc_", "000A00:Vendor.esp"); // sorts after newPath
            var oldAbsolute = Path.Combine(originFolder, oldPath);
            var newAbsolute = Path.Combine(originFolder, newPath);
            var laterAbsolute = Path.Combine(originFolder, laterPath);

            ledger.EnsureRepo(originFolder);
            Directory.CreateDirectory(Path.GetDirectoryName(oldAbsolute)!);
            File.WriteAllText(oldAbsolute, "EditorID: SpikeNpc\nName: Pristine\nFormKey: 000800:Vendor.esp\n");
            File.WriteAllText(laterAbsolute, "FormKey: 000A00:Vendor.esp\n");
            ledger.StagePath(originFolder, oldPath);
            ledger.StagePath(originFolder, laterPath);
            ledger.CommitStaged(originFolder, "vendor: baseline");

            // The crashed-renumber shape: identical content moved to the new path, both sides
            // staged, no commit. Identical blobs make git's rename inference a certainty.
            File.Move(oldAbsolute, newAbsolute);
            ledger.StagePath(originFolder, oldPath);
            ledger.StagePath(originFolder, newPath);

            // An ordinary working-tree edit sorting after the rename — the entry the swallowed
            // origin-path field would corrupt.
            File.AppendAllText(laterAbsolute, "Aggression: Frenzied\n");

            var status = ledger.WorkingTreeStatus(originFolder);

            Assert.Equal(2, status.Count);
            Assert.Equal(('R', newPath), status[0]);
            Assert.Equal(('M', laterPath), status[1]);
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(originFolder, recursive: true);
        }
    }
}
