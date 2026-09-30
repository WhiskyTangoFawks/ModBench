using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

/// <summary>ADR-0009: once a validation has read the whole tree, the next reads only what git names
/// as changed since the HEAD it validated, and what the index itself holds as dirty.</summary>
public sealed class ValidateThroughGitTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _mod;
    private readonly Indexer _index;
    private readonly string _npc;

    public ValidateThroughGitTests()
    {
        FormKey npc = default;
        _fixture = new PluginFixtureBuilder("validate-through-git")
            .WithPlugin("Fixture.esp", mod => npc = mod.Npcs.AddNew("FixtureNpc").FormKey, origin: "FixtureMod")
            .BuildScattered()
            .Tracked();
        _mod = _fixture.Plugins.Single();
        _npc = npc.ToString();
        _index = Indexes.Reconciled(_fixture);
        Validate();
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private IRecordReads Reads => _index.RequireReads();

    private ValidationReport Validate() => Assert.Single(_index.ValidateIndex(_mod.KeyOf()));

    private string NpcFile => _mod.SourceFileOf(Reads.DocumentOf(_npc, _mod.KeyOf()));

    private string GitPath(string file) => Path.GetRelativePath(_mod.ModFolderOf(), file).Replace('\\', '/');

    // A handle that denies sharing makes a read fail, so a clean answer while it is open came from
    // git vouching for the document.
    [Fact]
    public void ADocumentGitReportsClean_IsNotRead()
    {
        using var held = new FileStream(NpcFile, FileMode.Open, FileAccess.Read, FileShare.None);

        var report = Validate();

        Assert.Empty(report.Failures);
        Assert.False(report.NeedsRebuild);
    }

    [Fact]
    public void AHandEdit_IsFoundThroughGitStatus()
    {
        _mod.HandEdit(Reads.DocumentOf(_npc, _mod.KeyOf()), "\"FixtureNpc\"", "\"RenamedByHand\"");

        var report = Validate();

        Assert.Equal("RenamedByHand", Reads.DocumentOf(_npc, _mod.KeyOf()).EditorId);
        Assert.Contains(_npc, report.ChangedKeys, StringComparer.Ordinal);
    }

    [Fact]
    public void ADirtyDocumentUnchangedSinceTheLastValidation_AdvancesNoSequence()
    {
        _mod.HandEdit(Reads.DocumentOf(_npc, _mod.KeyOf()), "\"FixtureNpc\"", "\"RenamedByHand\"");
        Validate();
        var before = _index.Sequence;

        var report = Validate();

        Assert.Empty(report.ChangedKeys);
        Assert.Equal(before, _index.Sequence);
    }

    // Clean again, so git names nothing: the index's own dirty row is what brings it back.
    [Fact]
    public void AHandEditThatGitRestores_ReturnsTheRecordToHead()
    {
        _mod.HandEdit(Reads.DocumentOf(_npc, _mod.KeyOf()), "\"FixtureNpc\"", "\"RenamedByHand\"");
        Validate();
        _mod.Git("checkout", "--", GitPath(NpcFile));

        Validate();

        var entry = Reads.StackEntry(_npc, _mod.KeyOf()).Require();
        Assert.False(entry.HasWorkingTreeChange);
        Assert.Equal("FixtureNpc", Reads.DocumentOf(_npc, _mod.KeyOf()).EditorId);
    }

    [Fact]
    public void ADeletedDocumentThatGitRestores_ComesBack()
    {
        var file = NpcFile;
        File.Delete(file);
        Validate();
        Assert.Null(Reads.GetDocument(_npc, _mod.KeyOf()));
        _mod.Git("checkout", "--", GitPath(file));

        Validate();

        Assert.Equal("FixtureNpc", Reads.DocumentOf(_npc, _mod.KeyOf()).EditorId);
        Assert.False(Reads.StackEntry(_npc, _mod.KeyOf()).Require().HasWorkingTreeChange);
    }

    // Never committed, so once gone git has nothing to say about it.
    [Fact]
    public void AnUncommittedDocumentDeletedByHand_LosesItsRows()
    {
        const string created = "000900:Fixture.esp";
        _index.Create(_mod, created, "npc_", "CreatedNpc",
            Reads.DocumentOf(_npc, _mod.KeyOf()).BodyOf()
                .Replace(_npc, created, StringComparison.Ordinal)
                .Replace("\"FixtureNpc\"", "\"CreatedNpc\"", StringComparison.Ordinal));
        Validate();
        File.Delete(_mod.SourceFileOf(Reads.DocumentOf(created, _mod.KeyOf())));

        Validate();

        Assert.Null(Reads.GetDocument(created, _mod.KeyOf()));
    }

    // HEAD held back from the deletion would make the same bytes coming back a clean record rather
    // than one the working tree adds.
    [Fact]
    public void ADeletionCommittedOutsideModbench_LeavesNothingAtHead()
    {
        var file = NpcFile;
        var text = File.ReadAllText(file);
        File.Delete(file);
        Validate();
        _mod.Git("commit", "-q", "-am", "a deletion committed outside Modbench");
        Validate();

        File.WriteAllText(file, text);
        Validate();

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

    // Refreshing the locked document throws, so that validation records no HEAD, and the next one
    // names the commit again.
    [Fact]
    public void ADocumentACommitChangedButThatCouldNotBeRead_IsRefreshedByTheNextValidation()
    {
        _mod.HandEdit(Reads.DocumentOf(_npc, _mod.KeyOf()), "\"FixtureNpc\"", "\"RenamedByHand\"");
        _mod.Git("commit", "-q", "-am", "an edit committed outside Modbench");
        using (new FileStream(NpcFile, FileMode.Open, FileAccess.Read, FileShare.None))
            Assert.NotEmpty(Validate().Failures);

        Validate();

        Assert.Equal("RenamedByHand", Reads.DocumentOf(_npc, _mod.KeyOf()).EditorId);
    }

    // Committed, so git names it only once: the plugin's failure stands until the tree changes.
    [Fact]
    public void ACommittedDocumentDeclaringNoRecord_FailsThePlugin_ThroughEveryValidation()
    {
        var stray = Path.Combine(Path.GetDirectoryName(NpcFile).Require(), "Stray - 000A00_Fixture.esp.json");
        File.WriteAllText(stray, "{\"EditorID\":\"Stray\"}");
        _mod.Git("add", "--", GitPath(stray));
        _mod.Git("commit", "-q", "-m", "a document declaring no FormKey");
        Assert.NotEmpty(Validate().Failures);

        Validate();

        Assert.Contains(_index.Status.Failures, f => f.Name == _mod.Name);
    }

    // The tree gone, the rows come from the binary; the tree back at the same HEAD reads clean to
    // git, so only a whole-tree read puts the tree's rows back.
    [Fact]
    public void ATreeRestoredAtTheSameHead_ReplacesTheBinarysRows()
    {
        _mod.HandEdit(Reads.DocumentOf(_npc, _mod.KeyOf()), "\"FixtureNpc\"", "\"RenamedByHand\"");
        _mod.Git("commit", "-q", "-am", "an edit committed outside Modbench");
        Validate();
        var tree = SourceRepository.RootIn(_mod.ModFolderOf(), _mod.Name);
        Directory.Move(tree, tree + ".away");
        Validate();
        Assert.Equal("FixtureNpc", Reads.DocumentOf(_npc, _mod.KeyOf()).EditorId);
        Directory.Move(tree + ".away", tree);

        Validate();

        Assert.Equal("RenamedByHand", Reads.DocumentOf(_npc, _mod.KeyOf()).EditorId);
    }

    // The first validation after an open reads the whole tree, and HEAD holds nothing for a
    // record whose deletion was committed while the index was closed.
    [Fact]
    public void ADeletionCommittedBetweenOpens_LeavesNothingAtHead()
    {
        var instanceRoot = Directory.CreateTempSubdirectory("validate-through-git-instance-").FullName;
        try
        {
            var file = NpcFile;
            var text = File.ReadAllText(file);
            using (var first = Indexes.Reconciled(_fixture, instanceRoot))
            {
                File.Delete(file);
                first.ValidateIndex(_mod.KeyOf());
            }
            _mod.Git("commit", "-q", "-am", "a deletion committed while the index was closed");

            using var second = Indexes.Reconciled(_fixture, instanceRoot);
            File.WriteAllText(file, text);
            second.ValidateIndex(_mod.KeyOf());

            var listing = second.RequireReads().Search(new RecordQuery(Plugin: _mod.Name, Origin: _mod.Origin, RecordTypes: ["npc_"], Limit: 50));
            Assert.Equal(WorkingTreeState.Added, listing.Items.Single(i => i.FormKey == _npc).WorkingTreeState);
        }
        finally
        {
            Directory.Delete(instanceRoot, recursive: true);
        }
    }

    // A staged move names the path it left as well as the one it made, so HEAD keeps the record.
    [Fact]
    public void AStagedRename_KeepsTheRecordAtHead()
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

        var report = Validate();

        var listing = Reads.Search(new RecordQuery(Plugin: _mod.Name, Origin: _mod.Origin, RecordTypes: ["npc_"], Limit: 50));
        Assert.Equal(WorkingTreeState.Added, listing.Items.Single(i => i.FormKey == _npc).WorkingTreeState);
        Assert.Contains(_npc, report.ChangedKeys, StringComparer.Ordinal);
    }

    // A copy under a name that carries its FormKey reads as a new document for a record HEAD
    // already holds, and only the whole tree shows the two documents.
    [Fact]
    public void ACopyOfACommittedDocument_IsReportedWithBothDocuments()
    {
        var document = NpcFile;
        var copy = Path.Combine(Path.GetDirectoryName(document).Require(), $"Twin - {Path.GetFileName(document).Split(" - ")[^1]}");
        File.Copy(document, copy);

        Assert.NotEmpty(Validate().Failures);

        var failure = Assert.Single(_index.Status.Failures);
        Assert.Contains(Path.GetRelativePath(_mod.ModFolderOf(), document), failure.Reason, StringComparison.Ordinal);
        Assert.Contains(Path.GetRelativePath(_mod.ModFolderOf(), copy), failure.Reason, StringComparison.Ordinal);
    }
}
