using System.Text.Json;
using MEditService.Core.Ledger;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Ledger;

/// <summary>
/// #371 review: <see cref="LedgerGroupCommitter"/>'s own contract at its own public seam (real git,
/// no HTTP) — the new, central logic this ticket's original test suite never exercised: the
/// multi-record message branch, the per-origin-folder <c>GroupBy</c> split, origin-folder key
/// normalization, and the stray-index-entry recovery <see cref="LedgerRepository.ResetIndexToHead"/>
/// exists for. Mirrors <see cref="RecordVendorApplyFieldsTests"/>'s own seam choice — narrower than
/// the API host, real git throughout.
/// </summary>
public sealed class LedgerGroupCommitterTests
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private static JsonElement J(string raw) => JsonDocument.Parse(raw).RootElement.Clone();

    private static (RecordVendor Vendor, LedgerGroupCommitter Committer, LedgerRepository Ledger) MakeCollaborators(string ledgerRoot)
    {
        var ledger = new LedgerRepository(new LedgerOptions(ledgerRoot), NullLogger<LedgerRepository>.Instance);
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var vendor = new RecordVendor(ledger, codec, NullLogger<RecordVendor>.Instance);
        var committer = new LedgerGroupCommitter(ledger, NullLogger<LedgerGroupCommitter>.Instance);
        return (vendor, committer, ledger);
    }

    private static string WritePlugin(string originFolder, string pluginFileName, out string npc1FormKey, out string npc2FormKey)
    {
        var pluginPath = Path.Combine(originFolder, pluginFileName);
        var mod = new Fallout4Mod(ModKey.FromFileName(pluginFileName), Fallout4Release.Fallout4);
        var npc1 = mod.Npcs.AddNew("CommitterNpc1");
        var npc2 = mod.Npcs.AddNew("CommitterNpc2");
        mod.WriteToBinary(pluginPath);
        npc1FormKey = npc1.FormKey.ToString();
        npc2FormKey = npc2.FormKey.ToString();
        return pluginPath;
    }

    // Vendors + stages dirt for one record — the state LedgerGroupCommitter expects to find
    // waiting for it (RecordVendor writes it on every stage, per ADR-0040; this stands in for the
    // "already staged by a prior PATCH" precondition without needing EditOrchestrator/HTTP).
    private static async Task VendorAsync(RecordVendor vendor, string originFolder, string pluginPath, string pluginFileName, string formKey)
    {
        await vendor.VendorAndStageDirtAsync(
            originFolder, pluginPath, pluginFileName, "npc_", typeof(Npc), formKey,
            new Dictionary<string, JsonElement> { ["aggression"] = J("\"Frenzied\"") },
            Schemas, GameRelease.Fallout4);
    }

    private static int CommitCount(LedgerRepository ledger, string originFolder)
    {
        var (gitDir, workTree) = ledger.PathsFor(originFolder);
        var log = GitCli.Run(gitDir, workTree, "log", "--oneline", "main");
        return log.Split('\n', StringSplitOptions.RemoveEmptyEntries).Length;
    }

    // AC1, multi-record: the records.Count > 1 message branch, never exercised by any fixture in
    // the original suite (every one staged exactly one record).
    [Fact]
    public async Task CommitGroupSave_TwoRecordsInOneOrigin_ProducesExactlyOneCommitCoveringBoth()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-group-committer-ledger-").FullName;
        var originFolder = Directory.CreateTempSubdirectory("medit-group-committer-origin-").FullName;
        try
        {
            var (vendor, committer, ledger) = MakeCollaborators(ledgerRoot);
            const string pluginFileName = "Multi.esp";
            var pluginPath = WritePlugin(originFolder, pluginFileName, out var npc1FormKey, out var npc2FormKey);

            await VendorAsync(vendor, originFolder, pluginPath, pluginFileName, npc1FormKey);
            await VendorAsync(vendor, originFolder, pluginPath, pluginFileName, npc2FormKey);
            Assert.Equal(2, CommitCount(ledger, originFolder)); // two vendor baselines, nothing saved yet

            committer.CommitGroupSave([
                new LedgerTouchedRecord(originFolder, pluginFileName, "npc_", npc1FormKey),
                new LedgerTouchedRecord(originFolder, pluginFileName, "npc_", npc2FormKey),
            ]);

            // Exactly one new commit — not two — covering both records.
            Assert.Equal(3, CommitCount(ledger, originFolder));

            var (gitDir, workTree) = ledger.PathsFor(originFolder);
            // %B (raw body), not %s (subject only) — the itemized FormKey list is in the body,
            // after the "save: 2 records" subject line.
            var message = GitCli.Run(gitDir, workTree, "log", "-1", "--format=%B", "main");
            Assert.Contains("2 records", message, StringComparison.Ordinal);
            Assert.Contains(npc1FormKey, message, StringComparison.Ordinal);
            Assert.Contains(npc2FormKey, message, StringComparison.Ordinal);

            var committedFiles = GitCli.Run(gitDir, workTree, "show", "--stat", "--format=", "HEAD");
            var relPath1 = LedgerRecordPath.For(pluginFileName, "npc_", npc1FormKey).Replace('\\', '/');
            var relPath2 = LedgerRecordPath.For(pluginFileName, "npc_", npc2FormKey).Replace('\\', '/');
            Assert.Contains(relPath1, committedFiles, StringComparison.Ordinal);
            Assert.Contains(relPath2, committedFiles, StringComparison.Ordinal);

            // Both ledger-tracked paths are clean now — no leftover staged/unstaged entry for
            // either. The plugin binary itself (untracked, "??") is expected noise: it sits inside
            // the ledger's own working tree but is never added to git.
            AssertNoStagedOrTrackedChanges(gitDir, workTree, relPath1, relPath2);
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(originFolder, recursive: true);
        }
    }

    // Mutation-testing finding: a mixed batch — one ledger-tracked record, one that is not (the
    // realistic shape #389 produces: a group with an ordinary field edit alongside a VMAD
    // struct-op edit, which is never vendored) — must still commit the tracked record. The risk a
    // surviving mutant exposed isn't "the untracked record is mishandled", it's "the untracked
    // record's presence silently drops the *whole batch's* commit" (IsTrackedAtHead's skip removed
    // would make LedgerRecordPath's path a ledger file that was never written, so `git add` on it
    // would throw, rolling back the tracked record's own staging too) — this test fails either way
    // that could happen, not just the specific one already caught.
    [Fact]
    public async Task CommitGroupSave_MixedTrackedAndUntrackedRecordsInOneBatch_StillCommitsTheTrackedOne()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-group-committer-ledger-").FullName;
        var originFolder = Directory.CreateTempSubdirectory("medit-group-committer-origin-").FullName;
        try
        {
            var (vendor, committer, ledger) = MakeCollaborators(ledgerRoot);
            const string pluginFileName = "Mixed.esp";
            var pluginPath = WritePlugin(originFolder, pluginFileName, out var npc1FormKey, out var npc2FormKey);

            // Only npc1 is ever vendored — npc2 stands in for a record whose only touch this group
            // never reached the ledger (e.g. a VMAD-struct-op-only edit, #389).
            await VendorAsync(vendor, originFolder, pluginPath, pluginFileName, npc1FormKey);
            Assert.Equal(1, CommitCount(ledger, originFolder));

            committer.CommitGroupSave([
                new LedgerTouchedRecord(originFolder, pluginFileName, "npc_", npc1FormKey),
                new LedgerTouchedRecord(originFolder, pluginFileName, "npc_", npc2FormKey),
            ]);

            // Exactly one new commit, for the tracked record only — the untracked one never
            // poisoned the batch.
            Assert.Equal(2, CommitCount(ledger, originFolder));

            var (gitDir, workTree) = ledger.PathsFor(originFolder);
            var committedFiles = GitCli.Run(gitDir, workTree, "show", "--stat", "--format=", "HEAD").Trim();
            var npc1RelativePath = LedgerRecordPath.For(pluginFileName, "npc_", npc1FormKey).Replace('\\', '/');
            Assert.Equal(npc1RelativePath, committedFiles.Split('|')[0].Trim());

            Assert.False(ledger.IsTrackedAtHead(originFolder, LedgerRecordPath.For(pluginFileName, "npc_", npc2FormKey)));
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(originFolder, recursive: true);
        }
    }

    // AC1/Q2, multi-origin: the GroupBy(OriginFolder) split — one independent, non-atomic commit
    // per origin folder touched, never exercised by any fixture in the original suite (every one
    // touched a single origin).
    [Fact]
    public async Task CommitGroupSave_RecordsAcrossTwoOrigins_ProducesOneIndependentCommitPerOrigin()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-group-committer-ledger-").FullName;
        var origin1 = Directory.CreateTempSubdirectory("medit-group-committer-origin1-").FullName;
        var origin2 = Directory.CreateTempSubdirectory("medit-group-committer-origin2-").FullName;
        try
        {
            var (vendor, committer, ledger) = MakeCollaborators(ledgerRoot);
            var plugin1Path = WritePlugin(origin1, "Origin1.esp", out var npc1FormKey, out _);
            var plugin2Path = WritePlugin(origin2, "Origin2.esp", out var npc3FormKey, out _);

            await VendorAsync(vendor, origin1, plugin1Path, "Origin1.esp", npc1FormKey);
            await VendorAsync(vendor, origin2, plugin2Path, "Origin2.esp", npc3FormKey);

            committer.CommitGroupSave([
                new LedgerTouchedRecord(origin1, "Origin1.esp", "npc_", npc1FormKey),
                new LedgerTouchedRecord(origin2, "Origin2.esp", "npc_", npc3FormKey),
            ]);

            // Each origin gets its own commit, on its own independent history — two gitdirs, not one.
            Assert.Equal(2, CommitCount(ledger, origin1)); // vendor + this save
            Assert.Equal(2, CommitCount(ledger, origin2)); // vendor + this save

            var (gitDir1, workTree1) = ledger.PathsFor(origin1);
            var (gitDir2, workTree2) = ledger.PathsFor(origin2);
            Assert.NotEqual(gitDir1, gitDir2);

            var message1 = GitCli.Run(gitDir1, workTree1, "log", "-1", "--format=%s", "main");
            var message2 = GitCli.Run(gitDir2, workTree2, "log", "-1", "--format=%s", "main");
            Assert.Contains(npc1FormKey, message1, StringComparison.Ordinal);
            Assert.Contains(npc3FormKey, message2, StringComparison.Ordinal);
            Assert.DoesNotContain(npc3FormKey, message1, StringComparison.Ordinal);
            Assert.DoesNotContain(npc1FormKey, message2, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(origin1, recursive: true);
            Directory.Delete(origin2, recursive: true);
        }
    }

    // Review finding 2: two LedgerTouchedRecords naming the same physical origin folder in
    // differently-formatted strings must still land in one group and produce one commit — the
    // GroupBy key must normalize the same way LedgerOriginGate.GateFor/LedgerRepository.PathsFor
    // already do, or "exactly one commit" breaks a second way.
    [Fact]
    public async Task CommitGroupSave_SameOriginFolderInDifferentlyFormattedStrings_ProducesExactlyOneCommit()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-group-committer-ledger-").FullName;
        var originFolder = Directory.CreateTempSubdirectory("medit-group-committer-origin-").FullName;
        try
        {
            var (vendor, committer, ledger) = MakeCollaborators(ledgerRoot);
            const string pluginFileName = "Vendor.esp";
            var pluginPath = WritePlugin(originFolder, pluginFileName, out var npc1FormKey, out var npc2FormKey);
            await VendorAsync(vendor, originFolder, pluginPath, pluginFileName, npc1FormKey);
            await VendorAsync(vendor, originFolder, pluginPath, pluginFileName, npc2FormKey);
            Assert.Equal(2, CommitCount(ledger, originFolder));

            // Same physical folder, two different string forms — a redundant "nested/.." segment is
            // a difference Path.GetFullPath actually collapses (verified directly: a bare trailing
            // separator, tried first, is *not* one — GetFullPath leaves "/foo" and "/foo/" distinct
            // on this platform, so it would have proven nothing). Two *different* records, one
            // under each form: if grouping ever split on the raw string, each record would land in
            // its own group and get its own commit — git's own idempotent `git add` on unchanged
            // content would silently absorb a same-record repeat, so the defect only surfaces with
            // genuinely distinct content on each side.
            var differentlyFormatted = Path.Combine(originFolder, "nested", "..");
            Assert.NotEqual(originFolder, differentlyFormatted, StringComparer.Ordinal);
            Assert.Equal(Path.GetFullPath(originFolder), Path.GetFullPath(differentlyFormatted));

            committer.CommitGroupSave([
                new LedgerTouchedRecord(originFolder, pluginFileName, "npc_", npc1FormKey),
                new LedgerTouchedRecord(differentlyFormatted, pluginFileName, "npc_", npc2FormKey),
            ]);

            // Exactly one new commit covering both records — not two independent ones into the
            // same gitdir.
            Assert.Equal(3, CommitCount(ledger, originFolder));
            var (gitDir, workTree) = ledger.PathsFor(originFolder);
            var message = GitCli.Run(gitDir, workTree, "log", "-1", "--format=%B", "main");
            Assert.Contains(npc1FormKey, message, StringComparison.Ordinal);
            Assert.Contains(npc2FormKey, message, StringComparison.Ordinal);
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(originFolder, recursive: true);
        }
    }

    // Review finding 1 (headline): a stray staged-but-never-committed entry left behind by an
    // earlier, unfinished attempt against this same origin folder (its own UnstagePath never ran)
    // must not get folded into this save's commit — ResetIndexToHead's own job, exercised here at
    // LedgerGroupCommitter's own seam (RecordVendorApplyFieldsTests covers the same hazard on
    // RecordVendor's own vendor-time path).
    [Fact]
    public async Task CommitGroupSave_StrayStagedEntryFromAnEarlierUnfinishedAttempt_IsNotSweptIntoTheCommit()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-group-committer-ledger-").FullName;
        var originFolder = Directory.CreateTempSubdirectory("medit-group-committer-origin-").FullName;
        try
        {
            var (vendor, committer, ledger) = MakeCollaborators(ledgerRoot);
            const string pluginFileName = "Vendor.esp";
            var pluginPath = WritePlugin(originFolder, pluginFileName, out var npc1FormKey, out var npc2FormKey);
            await VendorAsync(vendor, originFolder, pluginPath, pluginFileName, npc1FormKey);

            // Simulate the dead-process/failed-UnstagePath window: npc2's content written and
            // staged, but never committed and never unstaged.
            var strayRelativePath = LedgerRecordPath.For(pluginFileName, "npc_", npc2FormKey);
            var strayAbsolutePath = Path.Combine(originFolder, strayRelativePath);
            Directory.CreateDirectory(Path.GetDirectoryName(strayAbsolutePath)!);
            await File.WriteAllTextAsync(strayAbsolutePath, "FormKey: stray-never-committed\n");
            ledger.StagePath(originFolder, strayRelativePath);

            committer.CommitGroupSave([new LedgerTouchedRecord(originFolder, pluginFileName, "npc_", npc1FormKey)]);

            Assert.False(ledger.IsTrackedAtHead(originFolder, strayRelativePath));

            var (gitDir, workTree) = ledger.PathsFor(originFolder);
            var committedFiles = GitCli.Run(gitDir, workTree, "show", "--stat", "--format=", "HEAD").Trim();
            var npc1RelativePath = LedgerRecordPath.For(pluginFileName, "npc_", npc1FormKey).Replace('\\', '/');
            Assert.Equal(npc1RelativePath, committedFiles.Split('|')[0].Trim());

            Assert.True(File.Exists(strayAbsolutePath)); // no data loss — just correctly left uncommitted
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(originFolder, recursive: true);
        }
    }

    // TryUnstage's rollback path: a failure partway through staging (here, a malformed FormKey
    // for the second touched record — LedgerRecordPath.For throws before that record ever reaches
    // IsTrackedAtHead/StagePath) must roll back whatever this attempt already staged, never commit
    // anything, and — this is the invariant the stage/commit/unstage split exists for — leave
    // nothing behind that a later, unrelated successful commit could sweep in.
    [Fact]
    public async Task CommitGroupSave_FailureAfterPartialStaging_RollsBackAndDoesNotPolluteALaterCommit()
    {
        var ledgerRoot = Directory.CreateTempSubdirectory("medit-group-committer-ledger-").FullName;
        var originFolder = Directory.CreateTempSubdirectory("medit-group-committer-origin-").FullName;
        try
        {
            var (vendor, committer, ledger) = MakeCollaborators(ledgerRoot);
            const string pluginFileName = "Vendor.esp";
            var pluginPath = WritePlugin(originFolder, pluginFileName, out var npc1FormKey, out _);
            await VendorAsync(vendor, originFolder, pluginPath, pluginFileName, npc1FormKey);
            Assert.Equal(1, CommitCount(ledger, originFolder));

            // npc1 stages successfully; the second entry's FormKey is malformed, so
            // LedgerRecordPath.For throws before it ever reaches IsTrackedAtHead/StagePath —
            // exercising CommitOrigin's catch with npc1 already in `staged`.
            committer.CommitGroupSave([
                new LedgerTouchedRecord(originFolder, pluginFileName, "npc_", npc1FormKey),
                new LedgerTouchedRecord(originFolder, pluginFileName, "npc_", "not-a-valid-form-key"),
            ]);

            // Best-effort: never throws past the caller, and nothing committed for this attempt.
            Assert.Equal(1, CommitCount(ledger, originFolder));

            // Nothing left *staged* — npc1's own dirt (written by VendorAsync, still uncommitted
            // relative to HEAD) legitimately still shows as an unstaged modification (" M"), and the
            // plugin binary itself is untracked ("??"); the invariant TryUnstage's rollback holds is
            // "nothing staged survives a failed attempt", not "the working tree is pristine".
            var (rollbackGitDir, rollbackWorkTree) = ledger.PathsFor(originFolder);
            AssertNoStagedEntries(rollbackGitDir, rollbackWorkTree);

            // A later, clean save for npc1 alone must be unaffected — exactly one commit, exactly
            // npc1's own file, nothing left over from the rolled-back attempt.
            committer.CommitGroupSave([new LedgerTouchedRecord(originFolder, pluginFileName, "npc_", npc1FormKey)]);
            Assert.Equal(2, CommitCount(ledger, originFolder));

            var (gitDir, workTree) = ledger.PathsFor(originFolder);
            var committedFiles = GitCli.Run(gitDir, workTree, "show", "--stat", "--format=", "HEAD").Trim();
            var npc1RelativePath = LedgerRecordPath.For(pluginFileName, "npc_", npc1FormKey).Replace('\\', '/');
            Assert.Equal(npc1RelativePath, committedFiles.Split('|')[0].Trim());
        }
        finally
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(originFolder, recursive: true);
        }
    }

    // No line's status has a "staged" first column (A/M/D/R/C/U) — "??" (untracked, e.g. the
    // plugin binary itself, which is never added to git) and " X" (unstaged working-tree-only
    // change) are both fine; a real staged entry ("X " or "XY" with X neither space nor '?') is not.
    private static void AssertNoStagedEntries(string gitDir, string workTree)
    {
        var status = GitCli.Run(gitDir, workTree, "status", "--porcelain");
        foreach (var line in status.Split('\n', StringSplitOptions.RemoveEmptyEntries))
            Assert.True(line[0] is ' ' or '?', $"Unexpected staged entry: {line}");
    }

    // Neither relativePath appears in status at all — fully clean and committed. Stricter than
    // AssertNoStagedEntries (which only rules out staged leftovers): used where the caller expects
    // these specific paths to have nothing outstanding at all, staged or not.
    private static void AssertNoStagedOrTrackedChanges(string gitDir, string workTree, params string[] relativePaths)
    {
        var status = GitCli.Run(gitDir, workTree, "status", "--porcelain");
        foreach (var path in relativePaths)
            Assert.DoesNotContain(path, status, StringComparison.Ordinal);
    }
}
