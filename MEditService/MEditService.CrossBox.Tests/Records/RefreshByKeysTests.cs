using MEditService.Index;
using MEditService.SourceRepo;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.Records;

/// <summary>ADR-0014: the Index's one projection verb, exercised directly through the seam rather
/// than through the Source watcher, its caller — covered separately.</summary>
public sealed class RefreshByKeysTests : IDisposable
{
    private readonly IndexedModFixture _mod = IndexedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    private IRecordReads Reads => _mod.Index.RequireReads();

    private void Refresh(params string[] formKeys) => _mod.Index.RefreshKeys(_mod.Plugin, formKeys);

    private void Git(params string[] args) =>
        GitProbe.Run(Path.Combine(_mod.ModFolder, ".git"), _mod.ModFolder, args);

    [Fact]
    public void ARefreshedKey_ShowsAHandEditAtTheWorkingTree_ThenAtTheCommittedRefOnceCommitted()
    {
        var formKey = _mod.Npc.ToString();
        var text = File.ReadAllText(_mod.NpcSourceFile);
        File.WriteAllText(_mod.NpcSourceFile, text.Replace("\"FixtureNpc\"", "\"RenamedByHand\"", StringComparison.Ordinal));

        Refresh(formKey);

        var effective = Reads.GetDocument(formKey, _mod.Plugin);
        Assert.NotNull(effective);
        Assert.Equal("RenamedByHand", effective.EditorId);
        var atHead = Reads.HeadDocument(formKey, _mod.Plugin);
        Assert.NotNull(atHead);
        Assert.NotNull(atHead.Body);
        Assert.DoesNotContain("RenamedByHand", atHead.Body, StringComparison.Ordinal);

        Git("add", "-A");
        Git("commit", "-q", "-m", "committed outside Modbench");

        Refresh(formKey);

        var stack = Reads.GetOverrideStack(formKey);
        Assert.NotNull(stack);
        var entry = stack.Entries.Single();
        Assert.False(entry.HasWorkingTreeChange);
        Assert.Equal("RenamedByHand", entry.Head.EditorId);
    }

    [Fact]
    public void RefreshingAnUnchangedKey_AdvancesNoSequence()
    {
        var before = _mod.Index.Sequence;

        Refresh(_mod.Npc.ToString());

        Assert.Equal(before, _mod.Index.Sequence);
    }

    [Fact]
    public void RefreshingADriftedKey_AdvancesTheSequence()
    {
        var text = File.ReadAllText(_mod.NpcSourceFile);
        File.WriteAllText(_mod.NpcSourceFile, text.Replace("\"FixtureNpc\"", "\"RenamedByHand\"", StringComparison.Ordinal));
        var before = _mod.Index.Sequence;

        Refresh(_mod.Npc.ToString());

        Assert.True(_mod.Index.Sequence > before);
    }

    [Fact]
    public void ARefreshedKeyTheIndexHasNeverSeen_LandsTheRecordTheTreeHasGained()
    {
        // A create's whole file side, made without the write API: the document is in the tree and
        // nothing has told the Index about it.
        var formKey = "000F00:Fixture.esp";
        var body = File.ReadAllText(_mod.NpcSourceFile)
            .Replace(_mod.Npc.ToString(), formKey, StringComparison.Ordinal)
            .Replace("\"FixtureNpc\"", "\"HandCreated\"", StringComparison.Ordinal);
        File.WriteAllText(_mod.SourceFileFor(FormKey.Factory(formKey), "npc_", "HandCreated"), body);

        Refresh(formKey);

        // A document alone cannot say where the tree puts a record, so the copy is re-derived whole
        // — and the record, its identity row and its EditorID all arrive with it.
        Assert.Equal("HandCreated", Reads.GetDocument(formKey, _mod.Plugin)?.EditorId);
        Assert.Contains(formKey, Reads.GetNativeFormKeys(_mod.Plugin));
        // Never committed, so the listing reports it as an addition.
        var listing = Reads.Search(new RecordQuery(Plugin: _mod.Plugin.Name, Origin: _mod.Plugin.Origin, RecordTypes: ["npc_"], Limit: 50));
        Assert.Equal(WorkingTreeState.Added, listing.Items.Single(i => i.FormKey == formKey).WorkingTreeState);
    }

    [Fact]
    public void ARefreshedKeyWhoseDocumentIsNotReadable_LeavesItsRowsAsTheyStand()
    {
        var formKey = _mod.Npc.ToString();
        var beforeDocument = Reads.GetDocument(formKey, _mod.Plugin);
        Assert.NotNull(beforeDocument);
        var before = beforeDocument.Body;

        // Mid-save, or hand-edited into something that is not a document at all: never assume
        // exclusive ownership of the file.
        File.WriteAllText(_mod.NpcSourceFile, "{ this is not json");

        Refresh(formKey);

        var afterDocument = Reads.GetDocument(formKey, _mod.Plugin);
        Assert.NotNull(afterDocument);
        Assert.Equal(before, afterDocument.Body);
    }
}
