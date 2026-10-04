using MEditService.Index.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

public sealed class ValidateThroughGitTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _mod;
    private readonly LoadOrderEntry _partner;
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly Indexer _index;
    private readonly string _npc;

    public ValidateThroughGitTests()
    {
        FormKey npc = default;
        _fixture = new PluginFixtureBuilder("validate-through-git")
            .WithPlugin("Fixture.esp", mod => npc = mod.Npcs.AddNew("FixtureNpc").FormKey, origin: "FixtureMod")
            .WithPlugin("Partner.esp", mod => mod.Npcs.AddNew("PartnerNpc"), origin: "PartnerMod")
            .BuildScattered()
            .Tracked();
        _mod = _fixture.Plugins.Single(p => p.Name == "Fixture.esp");
        _partner = _fixture.Plugins.Single(p => p.Name == "Partner.esp");
        _npc = npc.ToString();
        _index = Indexes.Reconciled(_fixture, notifications: _notifications);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private IRecordReads Reads => _index.RequireReads();

    private void Validate() => _index.NextSnapshot();

    private void ValidateUntilEditorId(string editorId) =>
        _index.NextSnapshotUntil(() => Reads.GetDocument(_npc, _mod.KeyOf())?.EditorId == editorId, $"the record named {editorId}");

    private void ValidateUntilFailed() => _index.NextSnapshotUntil(() => PluginFailed, "the plugin's failure");

    private bool PluginFailed => _index.Status.Failures.Any(f => f.Name == _mod.Name);

    private string NpcFile => _mod.SourceFileOf(Reads.DocumentOf(_npc, _mod.KeyOf()));

    private string GitPath(string file) => Path.GetRelativePath(_mod.ModFolderOf(), file).Replace('\\', '/');

    [Fact]
    public void ADocumentGitReportsClean_IsNotRead()
    {
        using var handleDenyingSharingSoAnyReadOfTheDocumentWouldFail = new FileStream(NpcFile, FileMode.Open, FileAccess.Read, FileShare.None);

        var announced = _index.AnnouncedByEqualArrivals(_notifications, () => _partner.RenamedByHand(Reads));

        Assert.False(PluginFailed);
        Assert.DoesNotContain(announced, Announcements.RowsChanged(_npc));
    }

    [Fact]
    public void ADirtyDocumentUnchangedSinceTheLastValidation_IsNotAnnouncedAgain()
    {
        _mod.HandEdit(Reads.DocumentOf(_npc, _mod.KeyOf()), "\"FixtureNpc\"", "\"RenamedByHand\"");
        Validate();

        var announced = _index.AnnouncedByEqualArrivals(_notifications, () => _partner.RenamedByHand(Reads));

        Assert.DoesNotContain(announced, Announcements.RowsChanged(_npc));
    }

    [Fact]
    public void AHandEditThatGitRestores_ReturnsTheRecordToHead_WhereGitNamesNothing()
    {
        _mod.HandEdit(Reads.DocumentOf(_npc, _mod.KeyOf()), "\"FixtureNpc\"", "\"RenamedByHand\"");
        ValidateUntilEditorId("RenamedByHand");
        _mod.Git("checkout", "--", GitPath(NpcFile));

        ValidateUntilEditorId("FixtureNpc");

        var entry = Reads.StackEntry(_npc, _mod.KeyOf()).Require();
        Assert.False(entry.HasWorkingTreeChange);
        Assert.Equal("FixtureNpc", Reads.DocumentOf(_npc, _mod.KeyOf()).EditorId);
    }

    [Fact]
    public void ADeletedDocumentThatGitRestores_ComesBack()
    {
        var file = NpcFile;
        File.Delete(file);
        _index.NextSnapshotUntil(() => Reads.GetDocument(_npc, _mod.KeyOf()) is null, "the record gone");
        _mod.Git("checkout", "--", GitPath(file));

        ValidateUntilEditorId("FixtureNpc");

        Assert.Equal("FixtureNpc", Reads.DocumentOf(_npc, _mod.KeyOf()).EditorId);
        Assert.False(Reads.StackEntry(_npc, _mod.KeyOf()).Require().HasWorkingTreeChange);
    }

    [Fact]
    public void AnUncommittedDocumentDeletedByHand_LosesItsRows()
    {
        const string created = "000900:Fixture.esp";
        _index.Create(_mod, created, "npc_", "CreatedNpc",
            Reads.DocumentOf(_npc, _mod.KeyOf()).BodyOf()
                .Replace(_npc, created, StringComparison.Ordinal)
                .Replace("\"FixtureNpc\"", "\"CreatedNpc\"", StringComparison.Ordinal));
        File.Delete(_mod.SourceFileOf(Reads.DocumentOf(created, _mod.KeyOf())));

        Validate();

        Assert.Null(Reads.GetDocument(created, _mod.KeyOf()));
    }

    [Fact]
    public void ADeletionCommittedOutsideModbench_LeavesNothingAtHead_SoTheSameBytesComingBackAreAdded()
    {
        var file = NpcFile;
        var text = File.ReadAllText(file);
        File.Delete(file);
        _index.NextSnapshotUntil(() => Reads.GetDocument(_npc, _mod.KeyOf()) is null, "the record gone");
        _mod.Git("commit", "-q", "-am", "a deletion committed outside Modbench");
        Validate();

        File.WriteAllText(file, text);
        ValidateUntilEditorId("FixtureNpc");

        var listing = Reads.Search(new RecordQuery(Plugin: _mod.Name, Origin: _mod.Origin, RecordTypes: ["npc_"], Limit: 50));
        Assert.Equal(WorkingTreeState.Added, listing.Items.Single(i => i.FormKey == _npc).WorkingTreeState);
    }

    [Fact]
    public void ACommitOutsideModbench_MovesTheRecordAtHead()
    {
        _mod.HandEdit(Reads.DocumentOf(_npc, _mod.KeyOf()), "\"FixtureNpc\"", "\"RenamedByHand\"");
        _mod.Git("commit", "-q", "-am", "an edit committed outside Modbench");

        Validate();

        var entry = Reads.StackEntry(_npc, _mod.KeyOf()).Require();
        Assert.False(entry.HasWorkingTreeChange);
        Assert.Equal("RenamedByHand", entry.Head.EditorId);
    }

    [Fact]
    public void ADocumentACommitChangedButThatCouldNotBeRead_IsRefreshedByTheNextValidation()
    {
        _mod.HandEdit(Reads.DocumentOf(_npc, _mod.KeyOf()), "\"FixtureNpc\"", "\"RenamedByHand\"");
        _mod.Git("commit", "-q", "-am", "an edit committed outside Modbench");
        using (new FileStream(NpcFile, FileMode.Open, FileAccess.Read, FileShare.None))
            ValidateUntilFailed();
        Assert.True(PluginFailed);

        Validate();

        Assert.Equal("RenamedByHand", Reads.DocumentOf(_npc, _mod.KeyOf()).EditorId);
    }

    [Fact]
    public void ACommittedDocumentDeclaringNoRecord_FailsThePlugin_AndStillFailsItOnTheNextValidation_WhereGitNamesItOnlyOnce()
    {
        var stray = Path.Combine(Path.GetDirectoryName(NpcFile).Require(), "Stray - 000A00_Fixture.esp.json");
        File.WriteAllText(stray, "{\"EditorID\":\"Stray\"}");
        _mod.Git("add", "--", GitPath(stray));
        _mod.Git("commit", "-q", "-m", "a document declaring no FormKey");
        ValidateUntilFailed();
        Assert.True(PluginFailed);

        _index.AnnouncedByEqualArrivals(_notifications, () => _partner.RenamedByHand(Reads));

        Assert.True(PluginFailed);
    }

    [Fact]
    public void ATreeRestoredAtTheSameHead_ReplacesTheBinarysRows()
    {
        _mod.HandEdit(Reads.DocumentOf(_npc, _mod.KeyOf()), "\"FixtureNpc\"", "\"RenamedByHand\"");
        _mod.Git("commit", "-q", "-am", "an edit committed outside Modbench");
        Validate();
        var treeWhoseRestoreAtTheSameHeadReadsCleanToGit = SourceRepository.RootIn(_mod.ModFolderOf(), _mod.Name);
        Directory.Move(treeWhoseRestoreAtTheSameHeadReadsCleanToGit, treeWhoseRestoreAtTheSameHeadReadsCleanToGit + ".away");
        ValidateUntilEditorId("FixtureNpc");
        Directory.Move(treeWhoseRestoreAtTheSameHeadReadsCleanToGit + ".away", treeWhoseRestoreAtTheSameHeadReadsCleanToGit);

        ValidateUntilEditorId("RenamedByHand");

        Assert.Equal("RenamedByHand", Reads.DocumentOf(_npc, _mod.KeyOf()).EditorId);
    }

    [Fact]
    public void ADeletionCommittedBetweenOpens_LeavesNothingAtHead()
    {
        using var instanceRoot = new ScratchDirectory("validate-through-git-instance-");
        var file = NpcFile;
        var text = File.ReadAllText(file);
        using (var first = Indexes.Reconciled(_fixture, instanceRoot))
        {
            File.Delete(file);
            first.NextSnapshot();
        }
        _mod.Git("commit", "-q", "-am", "a deletion committed while the index was closed");

        using var second = Indexes.Reconciled(_fixture, instanceRoot);
        File.WriteAllText(file, text);
        second.NextSnapshot();

        var listing = second.RequireReads().Search(new RecordQuery(Plugin: _mod.Name, Origin: _mod.Origin, RecordTypes: ["npc_"], Limit: 50));
        Assert.Equal(WorkingTreeState.Added, listing.Items.Single(i => i.FormKey == _npc).WorkingTreeState);
    }

    [Fact]
    public void AStagedRename_KeepsTheRecordAtHead_BecauseAStagedMoveNamesThePathItLeftAsWellAsTheOneItMade()
    {
        var document = NpcFile;
        var renamed = Path.Combine(Path.GetDirectoryName(document).Require(), Path.GetFileName(document).Replace("FixtureNpc - ", "Renamed - ", StringComparison.Ordinal));
        _mod.Git("mv", GitPath(document), GitPath(renamed));

        using var index = Indexes.Reconciled(_fixture);

        var listing = index.RequireReads().Search(new RecordQuery(Plugin: _mod.Name, Origin: _mod.Origin, RecordTypes: ["npc_"], Limit: 50));
        Assert.Equal(WorkingTreeState.None, listing.Items.Single(i => i.FormKey == _npc).WorkingTreeState);
    }

    [Fact]
    public void ARecordCommittedOutOfHead_LosesItsCommittedRows()
    {
        _mod.Git("rm", "-q", "--cached", GitPath(NpcFile));
        _mod.Git("commit", "-q", "-m", "removed from the committed tree outside Modbench");

        Validate();

        Assert.NotNull(Reads.GetDocument(_npc, _mod.KeyOf()));
        var listing = Reads.Search(new RecordQuery(Plugin: _mod.Name, Origin: _mod.Origin, RecordTypes: ["npc_"], Limit: 50));
        Assert.Equal(WorkingTreeState.Added, listing.Items.Single(i => i.FormKey == _npc).WorkingTreeState);
    }

    [Fact]
    public void ACopyOfACommittedDocument_IsReportedWithBothDocuments()
    {
        var document = NpcFile;
        var copyNamedWithTheFormKeySuffixSoItReadsAsANewDocumentForARecordHeadAlreadyHolds =
            $"Twin - {Path.GetFileName(document).Split(" - ")[^1]}";
        var copy = Path.Combine(Path.GetDirectoryName(document).Require(), copyNamedWithTheFormKeySuffixSoItReadsAsANewDocumentForARecordHeadAlreadyHolds);
        File.Copy(document, copy);

        ValidateUntilFailed();

        Assert.Equal("FixtureNpc", Reads.DocumentOf(_npc, _mod.KeyOf()).EditorId);
        var failure = Assert.Single(_index.Status.Failures);
        Assert.Contains(Path.GetRelativePath(_mod.ModFolderOf(), document), failure.Reason, StringComparison.Ordinal);
        Assert.Contains(Path.GetRelativePath(_mod.ModFolderOf(), copy), failure.Reason, StringComparison.Ordinal);
    }

    [Fact]
    public void ValidatingEveryPlugin_WhenOnePluginsTreeCannotBeRead_StillValidatesTheOthers()
    {
        FormKey other = default;
        using var fixture = new PluginFixtureBuilder("validate-two-tracked")
            .WithPlugin("Broken.esp", mod => mod.Npcs.AddNew("BrokenNpc"), origin: "BrokenMod")
            .WithPlugin("Sound.esp", mod => other = mod.Npcs.AddNew("SoundNpc").FormKey, origin: "SoundMod")
            .BuildScattered()
            .Tracked();
        using var index = Indexes.Reconciled(fixture);
        var broken = fixture.Plugins.Single(p => p.Name == "Broken.esp");
        var sound = fixture.Plugins.Single(p => p.Name == "Sound.esp");
        var brokenDocument = broken.SourceFileOf(index.RequireReads().DocumentOf(
            index.RequireReads().Search(new RecordQuery(Plugin: broken.Name, Origin: broken.Origin, RecordTypes: ["npc_"], Limit: 1)).Items.Single().FormKey,
            broken.KeyOf()));
        var backup = Path.Combine(Directory.CreateDirectory(Path.Combine(Path.GetDirectoryName(brokenDocument).Require(), "Backup")).FullName, Path.GetFileName(brokenDocument));
        File.Copy(brokenDocument, backup);
        sound.HandEdit(index.RequireReads().DocumentOf(other.ToString(), sound.KeyOf()), "\"SoundNpc\"", "\"EditedSoundNpc\"");

        index.NextSnapshot();

        Assert.Equal("EditedSoundNpc", index.RequireReads().DocumentOf(other.ToString(), sound.KeyOf()).EditorId);
        Assert.Contains(index.Status.Failures, f => f.Name == "Broken.esp");
    }

    [Fact]
    public void AnUnreadableCommittedTree_IsReportedAndChangesNothing()
    {
        const string unbornBranchSoGitAnswersAsItDoesWhenTheCommittedTreeCannotBeListed = "refs/heads/no-such-branch";
        _mod.Git("symbolic-ref", "HEAD", unbornBranchSoGitAnswersAsItDoesWhenTheCommittedTreeCannotBeListed);
        var before = _index.Sequence;

        ValidateUntilFailed();

        Assert.True(PluginFailed);
        var entry = Reads.StackEntry(_npc, _mod.KeyOf());
        Assert.NotNull(entry);
        Assert.False(entry.HasWorkingTreeChange);
        Assert.Equal(before, _index.Sequence);
    }
}
