using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Records;

/// <summary>
/// What a working-tree change does to everything the read model <i>derives</i> from a
/// document, rather than to the document itself — winner status, FormKey resolution and the
/// reference graph. A body is not just bytes to serve back: it is the thing every extracted index
/// table was built from, so an edit that updates one and not the others leaves the read model
/// disagreeing with itself.
///
/// A <see langword="null"/> body is the deletion case (per the pinned seam contract), which is the
/// sharpest version of every question here: the record has to stop existing at Effective — winner,
/// lookup, references and all — while still answering at Head.
/// </summary>
public sealed class WorkingTreeDeletionTests : IDisposable
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private static readonly PluginKey BaseKey = new("Base.esm", "Data");
    private static readonly PluginKey WinnerKey = new("Winner.esp", "Data");

    private readonly PluginFixtureData _fixture;
    private readonly string _npc;
    private readonly string _raceA;
    private readonly string _raceB;

    public WorkingTreeDeletionTests()
    {
        FormKey npc = default, raceA = default, raceB = default;
        _fixture = new PluginFixtureBuilder("working-tree-deletion")
            .WithPlugin("Base.esm", mod =>
            {
                raceA = mod.Races.AddNew("RaceA").FormKey;
                raceB = mod.Races.AddNew("RaceB").FormKey;
                var n = mod.Npcs.AddNew("TestNpc");
                n.Race.SetTo(raceA);
                npc = n.FormKey;
            })
            .WithPlugin("Winner.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });
                var basePlugin = built.Single(m => m.ModKey.FileName == "Base.esm");
                mod.Npcs.Set(basePlugin.Npcs.First(n => n.FormKey == npc).DeepCopy());
            })
            .Build();
        (_npc, _raceA, _raceB) = (npc.ToString(), raceA.ToString(), raceB.ToString());
    }

    public void Dispose() => _fixture.Dispose();

    private DuckDbRecordIndex LoadedIndex()
    {
        var index = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        index.Initialize(GameRelease.Fallout4);
        Open(index, "Base.esm", 0);
        Open(index, "Winner.esp", 1);
        index.UpdateWinners();
        return index;
    }

    private void Open(DuckDbRecordIndex index, string name, int loadOrderIndex)
    {
        var path = new ModPath(ModKey.FromFileName(name), Path.Combine(_fixture.DataFolder, name));
        index.Index(
            Fallout4Mod.CreateFromBinaryOverlay(path, Fallout4Release.Fallout4), Registration.Participating(loadOrderIndex), new PluginKey(name, "Data"));
    }

    [Fact]
    public void DeletingARecord_RemovesItFromEffective_WhileItKeepsAnsweringAtHead()
    {
        using var index = LoadedIndex();

        index.ApplyWorkingTreeChanges(BaseKey, [(_raceA, null)]);

        Assert.Null(index.At(RecordRef.Effective).GetDocument(_raceA, BaseKey));
        Assert.Null(index.At(RecordRef.Effective).GetDocument(_raceA));

        var head = index.At(RecordRef.Head).GetDocument(_raceA, BaseKey);
        Assert.NotNull(head);
        Assert.Equal("RaceA", head.EditorId);
    }

    [Fact]
    public void DeletingTheWinningOverride_PromotesTheNextPluginDown_AtEffectiveOnly()
    {
        using var index = LoadedIndex();
        Assert.Equal("Winner.esp", index.At(RecordRef.Effective).GetDocument(_npc)!.Plugin.Name);

        // Winner.esp's copy of the NPC is deleted in *its* working tree; Base.esm's copy is untouched
        // and must become the winner — a record's winner is a fact about the stack that survives at
        // this ref, not a stored flag that goes stale when the stack changes underneath it.
        index.ApplyWorkingTreeChanges(WinnerKey, [(_npc, null)]);

        var effectiveWinner = index.At(RecordRef.Effective).GetDocument(_npc);
        Assert.Equal("Base.esm", effectiveWinner!.Plugin.Name);
        Assert.True(effectiveWinner.IsWinner);

        // At Head nothing was deleted, so Winner.esp still wins — and Base.esm's row, which is the
        // *same physical row* the Effective sweep just promoted, must not have leaked that promotion
        // into the committed answer.
        var headStack = index.At(RecordRef.Head).GetOverrideStack(_npc)!;
        Assert.Equal(
            [("Base.esm", false), ("Winner.esp", true)],
            headStack.Entries.Select(e => (e.Plugin.Name, e.IsWinner)));
    }

    [Fact]
    public void RestoringADeletedOverride_MakesItTheEffectiveWinnerAgain_WithoutMovingHead()
    {
        using var index = LoadedIndex();
        var winnersCopy = index.At(RecordRef.Effective).GetDocument(_npc, WinnerKey)!.Body!;

        // Winner.esp's copy is deleted in its working tree, so Base.esm holds the field...
        index.ApplyWorkingTreeChanges(WinnerKey, [(_npc, null)]);
        Assert.Equal("Base.esm", index.At(RecordRef.Effective).GetDocument(_npc)!.Plugin.Name);

        // ...and then the file comes back, carrying a *different* value than the commit had. This is
        // the direction a create takes too: a row that does not exist at Effective appears, and its
        // appearance has to move winner status — the mirror of the deletion case above, and the one
        // the design named ("a working-tree create adding an override can flip the Effective
        // winner"). An implementation that re-swept winners only when a row was removed passes the
        // deletion test and fails this one.
        var edited = winnersCopy.Replace("TestNpc", "RestoredByWorkingTree", StringComparison.Ordinal);
        Assert.NotEqual(winnersCopy, edited);
        index.ApplyWorkingTreeChanges(WinnerKey, [(_npc, edited)]);

        var effectiveWinner = index.At(RecordRef.Effective).GetDocument(_npc)!;
        Assert.Equal("Winner.esp", effectiveWinner.Plugin.Name);
        Assert.True(effectiveWinner.IsWinner);
        Assert.Equal("RestoredByWorkingTree", effectiveWinner.EditorId);

        // Head never lost it, and must not have gained a second winner on the way through either.
        var headStack = index.At(RecordRef.Head).GetOverrideStack(_npc)!;
        Assert.Equal(
            [("Base.esm", false), ("Winner.esp", true)],
            headStack.Entries.Select(e => (e.Plugin.Name, e.IsWinner)));
        Assert.Equal("TestNpc", headStack.Entries.Single(e => e.Plugin.Name == "Winner.esp").Head.EditorId);
    }

    [Fact]
    public void DeletingARecord_StopsItResolving_SoAFormLinkToItReadsAsDangling()
    {
        using var index = LoadedIndex();
        Assert.NotNull(index.At(RecordRef.Effective).Resolve(_raceA));

        index.ApplyWorkingTreeChanges(BaseKey, [(_raceA, null)]);

        // FormKey resolution is what every FormLink check reads (CheckErrorBuilder), so this is the
        // mechanism by which a link to a record the working tree deleted becomes a dangling link.
        Assert.Null(index.At(RecordRef.Effective).Resolve(_raceA));
        Assert.NotNull(index.At(RecordRef.Effective).Resolve(_raceB));
    }

    [Fact]
    public void EditingAFormLink_MovesTheRecordInTheReferenceGraph()
    {
        using var index = LoadedIndex();
        Assert.Contains(index.At(RecordRef.Effective).GetReferencedBy(_raceA), r => r.FormKey == _npc);
        Assert.DoesNotContain(index.At(RecordRef.Effective).GetReferencedBy(_raceB), r => r.FormKey == _npc);

        var body = index.At(RecordRef.Effective).GetDocument(_npc, BaseKey)!.Body!;
        Assert.Contains(_raceA, body, StringComparison.Ordinal); // the fixture really does carry the link being repointed
        index.ApplyWorkingTreeChanges(BaseKey, [(_npc, body.Replace(_raceA, _raceB, StringComparison.Ordinal))]);

        Assert.DoesNotContain(index.At(RecordRef.Effective).GetReferencedBy(_raceA), r => r.FormKey == _npc && r.Plugin == "Base.esm");
        Assert.Contains(index.At(RecordRef.Effective).GetReferencedBy(_raceB), r => r.FormKey == _npc && r.Plugin == "Base.esm");
    }

    [Fact]
    public void DeletingARecord_TakesItsOutgoingReferencesWithIt()
    {
        using var index = LoadedIndex();
        Assert.Contains(index.At(RecordRef.Effective).GetReferencedBy(_raceA), r => r.FormKey == _npc && r.Plugin == "Base.esm");

        index.ApplyWorkingTreeChanges(BaseKey, [(_npc, null)]);

        Assert.DoesNotContain(index.At(RecordRef.Effective).GetReferencedBy(_raceA), r => r.FormKey == _npc && r.Plugin == "Base.esm");
    }
}
