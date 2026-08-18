using MEditService.Core.Ledger;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Ledger;

/// <summary>
/// #393: the commit-attempt scope — the staging protocol (gate → known-clean index → stage →
/// risky work → commit, or unstage on abandonment) as one object on <see cref="LedgerRepository"/>
/// instead of a five-step contract every committing caller re-implements. Real git throughout,
/// same as every other Ledger/ test; assertions go through the repository's own reads
/// (<see cref="LedgerRepository.ReadTextAtCommit"/>, <see cref="LedgerRepository.WorkingTreeStatus"/>)
/// and <see cref="GitCli"/> where the index itself is the subject.
/// </summary>
public sealed class LedgerCommitAttemptTests
{
    [Fact]
    public async Task Commit_CapturesContentAsStaged_NotLaterWorkingTreeDirt()
    {
        using var fixture = new Fixture("commit-captures-staged");
        var (ledger, originFolder) = (fixture.Ledger, fixture.OriginFolder);
        var relativePath = LedgerRecordPath.For("Vendor.esp", "npc_", "000800:Vendor.esp");
        var absolutePath = Path.Combine(originFolder, relativePath);
        const string staged = "FormKey: 000800:Vendor.esp\n";
        const string laterDirt = "FormKey: 000800:Vendor.esp\nAggression: Frenzied\n";

        using (var attempt = await ledger.BeginAttemptAsync(originFolder))
        {
            attempt.EnsureRepo();
            Directory.CreateDirectory(Path.GetDirectoryName(absolutePath)!);
            await File.WriteAllTextAsync(absolutePath, staged);
            attempt.Stage(relativePath);

            // The protocol's whole point: work after staging can rewrite the working-tree file
            // without the commit ever capturing that later content.
            await File.WriteAllTextAsync(absolutePath, laterDirt);
            attempt.Commit("vendor: npc_ 000800:Vendor.esp");
        }

        Assert.Equal(staged, ledger.ReadTextAtCommit(originFolder, relativePath, "HEAD"));
        var (code, path) = Assert.Single(ledger.WorkingTreeStatus(originFolder));
        Assert.Equal('M', code);
        Assert.Equal(relativePath, path);
    }

    [Fact]
    public async Task AbandonedAttempt_UnstagesWhatItStaged_FileStaysOnDisk()
    {
        using var fixture = new Fixture("abandon-unstages");
        var (ledger, originFolder) = (fixture.Ledger, fixture.OriginFolder);
        var relativePath = LedgerRecordPath.For("Vendor.esp", "npc_", "000800:Vendor.esp");
        var absolutePath = Path.Combine(originFolder, relativePath);
        const string pristine = "FormKey: 000800:Vendor.esp\n";

        // The RecordVendor failure shape: pristine staged, then the risky work throws and the
        // exception propagates out of the scope — no commit, and nothing left in the index for a
        // later unrelated commit to sweep in.
        await Assert.ThrowsAsync<InvalidOperationException>(async () =>
        {
            using var attempt = await ledger.BeginAttemptAsync(originFolder);
            attempt.EnsureRepo();
            Directory.CreateDirectory(Path.GetDirectoryName(absolutePath)!);
            await File.WriteAllTextAsync(absolutePath, pristine);
            attempt.Stage(relativePath);
            throw new InvalidOperationException("risky work failed");
        });

        var (gitDir, workTree) = ledger.PathsFor(originFolder);
        Assert.Equal("", GitCli.Run(gitDir, workTree, "diff", "--cached", "--name-only").Trim());
        Assert.Equal(pristine, File.ReadAllText(absolutePath));
    }

    [Fact]
    public async Task StrayIndexEntryFromACrashedEarlierAttempt_IsNotSweptIntoThisAttemptsCommit()
    {
        using var fixture = new Fixture("stray-not-swept");
        var (ledger, originFolder) = (fixture.Ledger, fixture.OriginFolder);
        var trackedPath = LedgerRecordPath.For("Vendor.esp", "npc_", "000800:Vendor.esp");
        var strayPath = LedgerRecordPath.For("Vendor.esp", "npc_", "000900:Vendor.esp");
        var trackedAbsolute = Path.Combine(originFolder, trackedPath);
        var strayAbsolute = Path.Combine(originFolder, strayPath);

        // Baseline: one tracked record (fixture setup through the internal primitives, the same
        // way every other Ledger/ test builds git state).
        ledger.EnsureRepo(originFolder);
        Directory.CreateDirectory(Path.GetDirectoryName(trackedAbsolute)!);
        await File.WriteAllTextAsync(trackedAbsolute, "FormKey: 000800:Vendor.esp\n");
        ledger.StagePath(originFolder, trackedPath);
        ledger.CommitStaged(originFolder, "vendor: baseline");

        // The crash shape from LedgerRepository's class remarks: an earlier attempt staged a path
        // and died before committing or unstaging — the orphan sits in the index.
        await File.WriteAllTextAsync(strayAbsolute, "FormKey: 000900:Vendor.esp\n");
        ledger.StagePath(originFolder, strayPath);

        using (var attempt = await ledger.BeginAttemptAsync(originFolder))
        {
            await File.WriteAllTextAsync(trackedAbsolute, "FormKey: 000800:Vendor.esp\nAggression: Frenzied\n");
            attempt.Stage(trackedPath);
            attempt.Commit("save: npc_ 000800:Vendor.esp");
        }

        // The commit carries only what this attempt staged; the stray never became tracked.
        Assert.False(ledger.IsTrackedAtHead(originFolder, strayPath));
        var (gitDir, workTree) = ledger.PathsFor(originFolder);
        var committedFiles = GitCli.Run(gitDir, workTree, "show", "--name-only", "--format=", "HEAD").Trim();
        Assert.Equal(trackedPath.Replace('\\', '/'), committedFiles);
    }

    [Fact]
    public async Task TwoAttemptsOnTheSameOriginFolder_Serialize_SecondWaitsForFirstsDispose()
    {
        using var fixture = new Fixture("attempts-serialize");
        var (ledger, originFolder) = (fixture.Ledger, fixture.OriginFolder);

        var first = await ledger.BeginAttemptAsync(originFolder);
        var secondTask = ledger.BeginAttemptAsync(originFolder);

        // git's own index.lock makes two interleaved staging sequences against one gitdir race
        // (one throws) — the scope must hold the second attempt at the door, not let it in to
        // lose that race.
        await Task.Delay(100);
        Assert.False(secondTask.IsCompleted);

        first.Dispose();
        using var second = await secondTask.WaitAsync(TimeSpan.FromSeconds(5));
    }

    private sealed class Fixture : IDisposable
    {
        public LedgerRepository Ledger { get; }
        public string OriginFolder { get; }
        private readonly string ledgerRoot;

        public Fixture(string label)
        {
            ledgerRoot = Directory.CreateTempSubdirectory($"medit-attempt-{label}-ledger-").FullName;
            OriginFolder = Directory.CreateTempSubdirectory($"medit-attempt-{label}-origin-").FullName;
            Ledger = new LedgerRepository(new LedgerOptions(ledgerRoot), NullLogger<LedgerRepository>.Instance);
        }

        public void Dispose()
        {
            Directory.Delete(ledgerRoot, recursive: true);
            Directory.Delete(OriginFolder, recursive: true);
        }
    }
}
