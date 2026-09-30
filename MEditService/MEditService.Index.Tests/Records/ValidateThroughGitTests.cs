using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
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

    // Read for the move of HEAD and failed: nothing vouches for it, so the next validation reads the
    // whole tree though git names nothing.
    [Fact]
    public void ADocumentACommitChangedButThatCouldNotBeRead_IsReadByTheNextValidation()
    {
        _mod.HandEdit(Reads.DocumentOf(_npc, _mod.KeyOf()), "\"FixtureNpc\"", "\"RenamedByHand\"");
        _mod.Git("commit", "-q", "-am", "an edit committed outside Modbench");
        using (new FileStream(NpcFile, FileMode.Open, FileAccess.Read, FileShare.None))
            Assert.NotEmpty(Validate().Failures);

        Validate();

        Assert.Equal("RenamedByHand", Reads.DocumentOf(_npc, _mod.KeyOf()).EditorId);
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
