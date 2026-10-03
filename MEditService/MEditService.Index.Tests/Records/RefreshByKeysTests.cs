using MEditService.Index.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

public sealed class RefreshByKeysTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _mod;
    private readonly Indexer _index;
    private readonly string _npc;

    public RefreshByKeysTests()
    {
        FormKey npc = default;
        _fixture = new PluginFixtureBuilder("refresh-by-keys")
            .WithPlugin("Fixture.esp", mod => npc = mod.Npcs.AddNew("FixtureNpc").FormKey, origin: "FixtureMod")
            .BuildScattered()
            .Tracked();
        _mod = _fixture.Plugins.Single();
        _npc = npc.ToString();
        _index = Indexes.Reconciled(_fixture);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private IRecordReads Reads => _index.RequireReads();

    private void Refresh() => _index.NextSnapshot();

    [Fact]
    public void ACommitMadeOutsideModbench_MovesTheCommittedRef_OnTheNextRefresh()
    {
        _mod.HandEdit(Reads.DocumentOf(_npc, _mod.KeyOf()), "\"FixtureNpc\"", "\"RenamedByHand\"");

        Refresh();

        var atHead = Reads.HeadDocument(_npc, _mod.KeyOf());
        Assert.NotNull(atHead);
        Assert.NotNull(atHead.Body);
        Assert.DoesNotContain("RenamedByHand", atHead.Body, StringComparison.Ordinal);

        _mod.Git("add", "-A");
        _mod.Git("commit", "-q", "-m", "committed outside Modbench");

        Refresh();

        var stack = Reads.GetOverrideStack(_npc);
        Assert.NotNull(stack);
        var entry = stack.Entries.Single();
        Assert.False(entry.HasWorkingTreeChange);
        Assert.Equal("RenamedByHand", entry.Head.EditorId);
    }

    [Fact]
    public void AHandEditMadeBeforeAnyRefresh_LeavesTheServedDocumentUnchanged()
    {
        var before = Reads.DocumentOf(_npc, _mod.KeyOf()).Body;

        _mod.HandEdit(Reads.DocumentOf(_npc, _mod.KeyOf()), "\"FixtureNpc\"", "\"RenamedByHand\"");

        Assert.Equal(before, Reads.DocumentOf(_npc, _mod.KeyOf()).Body);
        Assert.Equal("FixtureNpc", Reads.GetDocument(_npc, _mod.KeyOf())?.EditorId);

        Refresh();

        Assert.Equal("RenamedByHand", Reads.GetDocument(_npc, _mod.KeyOf())?.EditorId);
    }

    [Fact]
    public void ARefreshedKeyTheIndexHasNeverSeen_LandsTheRecordTheTreeHasGained_ListedAsAdded()
    {
        var formKey = "000F00:Fixture.esp";
        var body = Reads.DocumentOf(_npc, _mod.KeyOf()).BodyOf()
            .Replace(_npc, formKey, StringComparison.Ordinal)
            .Replace("\"FixtureNpc\"", "\"HandCreated\"", StringComparison.Ordinal);
        TrackedMods.RepositoryOf(_mod).Put(_mod.KeyOf(), new SourceDocument(formKey, "npc_", "HandCreated", body));

        Refresh();

        Assert.Equal("HandCreated", Reads.GetDocument(formKey, _mod.KeyOf())?.EditorId);
        Assert.Contains(formKey, Reads.GetNativeFormKeys(_mod.KeyOf()));
        var listing = Reads.Search(new RecordQuery(Plugin: _mod.Name, Origin: _mod.Origin, RecordTypes: ["npc_"], Limit: 50));
        Assert.Equal(WorkingTreeState.Added, listing.Items.Single(i => i.FormKey == formKey).WorkingTreeState);
    }

    [Fact]
    public void ARefreshedKeyWhoseDocumentIsNotReadable_LeavesItsRowsAsTheyStand()
    {
        var before = Reads.DocumentOf(_npc, _mod.KeyOf()).BodyOf();

        const string notADocumentAtAllAsAMidSaveOrHandEditedFileMayHold = "{ this is not json";
        File.WriteAllText(_mod.SourceFileOf(Reads.DocumentOf(_npc, _mod.KeyOf())), notADocumentAtAllAsAMidSaveOrHandEditedFileMayHold);

        Refresh();

        Assert.Equal(before, Reads.DocumentOf(_npc, _mod.KeyOf()).Body);
    }
}
