using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class WorkingTreeChangeMarkingTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _base;
    private readonly PluginAddress _baseKey;
    private readonly PluginAddress _winnerKey;
    private readonly string _keptNpc;
    private readonly string _soleSourcedNpcWhoseOneEntryIsItsOwnWinner;

    public WorkingTreeChangeMarkingTests()
    {
        FormKey keptFk = default, droppedFk = default;
        _fixture = new PluginFixtureBuilder("recordref-identity")
            .WithPlugin("Base.esm", mod =>
            {
                keptFk = mod.Npcs.AddNew("KeepMe").FormKey;
                droppedFk = mod.Npcs.AddNew("DropMe").FormKey;
            }, origin: "BaseMod")
            .WithPlugin("Winner.esp", (mod, built) =>
            {
                mod.ModHeader.MasterReferences.Add(new MasterReference { Master = ModKey.FromFileName("Base.esm") });
                var basePlugin = built.Single(m => m.ModKey.FileName == "Base.esm");
                mod.Npcs.Set(basePlugin.Npcs.First(n => n.FormKey == keptFk).DeepCopy());
            }, origin: "WinnerMod")
            .BuildScattered()
            .CompiledPlugin();
        _base = _fixture.Plugins.Single(p => p.Name == "Base.esm");
        _baseKey = _base.Key;
        _winnerKey = _fixture.Plugins.Single(p => p.Name == "Winner.esp").Key;
        _keptNpc = keptFk.ToString();
        _soleSourcedNpcWhoseOneEntryIsItsOwnWinner = droppedFk.ToString();
    }

    public void Dispose() => _fixture.Dispose();

    [Fact]
    public void AnActiveFilter_NarrowsTheListingToTheFormKeysItNames()
    {
        using var index = Indexes.Reconciled(_fixture);
        var filterNarrowingToKeepMesTwoOverrideRowsOfTheFixturesThree = $"SELECT '{_keptNpc}' AS form_key";
        index.SetFilter(filterNarrowingToKeepMesTwoOverrideRowsOfTheFixturesThree, "filter.sql");

        var listing = index.Queries.GetRecords(["npc_"], plugin: null, search: null, limit: 10, offset: 0).Value();

        Assert.Equal(2, listing.Total);
        Assert.All(listing.Items, i => Assert.Equal(_keptNpc, i.FormKey));
    }

    [Fact]
    public void AWorkingTreeChange_MarksOnlyTheEditedRecord()
    {
        using var index = Indexes.Reconciled(_fixture);
        var before = index.DocumentOf(_keptNpc, _baseKey);
        index.Edit(_base, before, index.BodyOf(_keptNpc, _baseKey).Replace("KeepMe", "RenamedInWorkingTree", StringComparison.Ordinal));

        Assert.Equal(WorkingTreeState.Modified, index.RowOf(_keptNpc, _baseKey)?.WorkingTreeState);
        Assert.Equal(WorkingTreeState.None, index.RowOf(_keptNpc, _winnerKey)?.WorkingTreeState);
        Assert.Equal(WorkingTreeState.None, index.RowOf(_soleSourcedNpcWhoseOneEntryIsItsOwnWinner, _baseKey)?.WorkingTreeState);
    }

    [Fact]
    public void ATreeDocumentDelimitingItsFormKeyWithAnUnderscore_IsTheRecordTheCanonicalKeyNames()
    {
        using var index = Indexes.Reconciled(_fixture);
        var document = Directory.EnumerateFiles(_base.ModFolderOf(), "*.json", SearchOption.AllDirectories)
            .Single(file => File.ReadAllText(file).Contains("\"KeepMe\"", StringComparison.Ordinal));
        File.WriteAllText(
            document,
            File.ReadAllText(document)
                .Replace(_keptNpc, _keptNpc.Replace(':', '_'), StringComparison.Ordinal)
                .Replace("KeepMe", "EditedInTree", StringComparison.Ordinal));

        index.NextSnapshotUntil(() => index.RowOf(_keptNpc, _baseKey)?.EditorId == "EditedInTree", "the edit read from the tree");

        Assert.Equal(WorkingTreeState.Modified, index.RowOf(_keptNpc, _baseKey)?.WorkingTreeState);
        Assert.Single(index.ListedIn(_baseKey), row => row.EditorId == "EditedInTree");
    }
}
