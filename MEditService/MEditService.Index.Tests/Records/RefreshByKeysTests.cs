using MEditService.Index;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.Records;

/// <summary>ADR-0015 invariant 3: the Index's one projection verb, over a tracked tree another tool
/// has moved under it — the cases the sequence tests do not reach.</summary>
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

    private void Refresh(params string[] formKeys) => _index.RefreshKeys(_mod.KeyOf(), formKeys);

    [Fact]
    public void ACommitMadeOutsideModbench_MovesTheCommittedRef_OnTheNextRefresh()
    {
        _mod.HandEdit(Reads.DocumentOf(_npc, _mod.KeyOf()), "\"FixtureNpc\"", "\"RenamedByHand\"");

        Refresh(_npc);

        var atHead = Reads.HeadDocument(_npc, _mod.KeyOf());
        Assert.NotNull(atHead);
        Assert.NotNull(atHead.Body);
        Assert.DoesNotContain("RenamedByHand", atHead.Body, StringComparison.Ordinal);

        _mod.Git("add", "-A");
        _mod.Git("commit", "-q", "-m", "committed outside Modbench");

        Refresh(_npc);

        var stack = Reads.GetOverrideStack(_npc);
        Assert.NotNull(stack);
        var entry = stack.Entries.Single();
        Assert.False(entry.HasWorkingTreeChange);
        Assert.Equal("RenamedByHand", entry.Head.EditorId);
    }

    // GetDocument answers from the Index's last projection, never a live re-read of the source
    // file — a hand-edit made outside Modbench is invisible until Refresh is told to look.
    [Fact]
    public void AHandEditMadeBeforeAnyRefresh_LeavesTheServedDocumentUnchanged()
    {
        var before = Reads.DocumentOf(_npc, _mod.KeyOf()).Body;

        _mod.HandEdit(Reads.DocumentOf(_npc, _mod.KeyOf()), "\"FixtureNpc\"", "\"RenamedByHand\"");

        Assert.Equal(before, Reads.DocumentOf(_npc, _mod.KeyOf()).Body);
        Assert.Equal("FixtureNpc", Reads.GetDocument(_npc, _mod.KeyOf())?.EditorId);

        Refresh(_npc);

        Assert.Equal("RenamedByHand", Reads.GetDocument(_npc, _mod.KeyOf())?.EditorId);
    }

    // A create's whole-file side, made without the write API: the document is in the tree and
    // nothing has told the Index about it.
    [Fact]
    public void ARefreshedKeyTheIndexHasNeverSeen_LandsTheRecordTheTreeHasGained()
    {
        var formKey = "000F00:Fixture.esp";
        var body = Reads.DocumentOf(_npc, _mod.KeyOf()).BodyOf()
            .Replace(_npc, formKey, StringComparison.Ordinal)
            .Replace("\"FixtureNpc\"", "\"HandCreated\"", StringComparison.Ordinal);
        TrackedMods.RepositoryOf(_mod).Put(_mod.KeyOf(), new SourceDocument(formKey, "npc_", "HandCreated", body));

        Refresh(formKey);

        // A document alone cannot say where the tree puts a record, so the plugin is re-derived whole
        // — and the record, its identity row and its EditorID all arrive with it.
        Assert.Equal("HandCreated", Reads.GetDocument(formKey, _mod.KeyOf())?.EditorId);
        Assert.Contains(formKey, Reads.GetNativeFormKeys(_mod.KeyOf()));
        // Never committed, so the listing reports it as an addition.
        var listing = Reads.Search(new RecordQuery(Plugin: _mod.Name, Origin: _mod.Origin, RecordTypes: ["npc_"], Limit: 50));
        Assert.Equal(WorkingTreeState.Added, listing.Items.Single(i => i.FormKey == formKey).WorkingTreeState);
    }

    [Fact]
    public void ARefreshedKeyWhoseDocumentIsNotReadable_LeavesItsRowsAsTheyStand()
    {
        var before = Reads.DocumentOf(_npc, _mod.KeyOf()).BodyOf();

        // Mid-save, or hand-edited into something that is not a document at all: never assume
        // exclusive ownership of the file (ADR-0003).
        File.WriteAllText(_mod.SourceFileOf(Reads.DocumentOf(_npc, _mod.KeyOf())), "{ this is not json");

        Refresh(_npc);

        Assert.Equal(before, Reads.DocumentOf(_npc, _mod.KeyOf()).Body);
    }
}
