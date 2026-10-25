using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class HandEditsReachTheNextSnapshotTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _mod;
    private readonly OpenedIndex _index;
    private readonly string _npc;

    public HandEditsReachTheNextSnapshotTests()
    {
        FormKey npc = default;
        _fixture = new PluginFixtureBuilder("refresh-by-keys")
            .WithPlugin("Fixture.esp", mod => npc = mod.Npcs.AddNew("FixtureNpc").FormKey, origin: "FixtureMod")
            .BuildScattered()
            .CompiledPlugin();
        _mod = _fixture.Plugins.Single();
        _npc = npc.ToString();
        _index = Indexes.Reconciled(_fixture);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    [Fact]
    public void AHandEdit_LeavesTheServedDocumentUnchanged_UntilTheNextSnapshot()
    {
        var before = _index.BodyOf(_npc, _mod.Key);

        _mod.HandEdit(_index.DocumentOf(_npc, _mod.Key), "\"FixtureNpc\"", "\"RenamedByHand\"");

        Assert.Equal(before, _index.BodyOf(_npc, _mod.Key));
        Assert.Equal("FixtureNpc", _index.CopyIn(_npc, _mod.Key)?.EditorId);

        _index.NextSnapshot();

        Assert.Equal("RenamedByHand", _index.CopyIn(_npc, _mod.Key)?.EditorId);
    }

    [Fact]
    public void ADocumentTheTreeGains_LandsAsARecordListedAsAdded()
    {
        var formKey = "000F00:Fixture.esp";
        var body = _index.BodyOf(_npc, _mod.Key)
            .Replace(_npc, formKey, StringComparison.Ordinal)
            .Replace("\"FixtureNpc\"", "\"HandCreated\"", StringComparison.Ordinal);
        SourceMods.RepositoryOf(_mod).Put(_mod.Key, new SourceDocument(formKey, "npc_", "HandCreated", body)).Wrote();

        _index.NextSnapshot();

        Assert.Equal("HandCreated", _index.CopyIn(formKey, _mod.Key)?.EditorId);
        var listing = _index.Queries.GetRecords(["npc_"], _mod.Key, search: null, limit: 50, offset: 0).Value();
        Assert.Equal(WorkingTreeState.Added, listing.Items.Single(i => i.FormKey == formKey).WorkingTreeState);
    }

    [Fact]
    public void AHandEditedDocumentThatIsNotReadable_ReadsTheBinaryInTheTreesPlace()
    {
        var npc = _index.DocumentOf(_npc, _mod.Key);
        var file = _mod.SourceFileOf(npc);
        _mod.HandEdit(npc, "\"FixtureNpc\"", "\"RenamedByHand\"");
        _index.NextSnapshot();
        Assert.Equal("RenamedByHand", _index.DocumentOf(_npc, _mod.Key).EditorId);

        const string notADocumentAtAllAsAMidSaveOrHandEditedFileMayHold = "{ this is not json";
        File.WriteAllText(file, notADocumentAtAllAsAMidSaveOrHandEditedFileMayHold);

        _index.NextSnapshotUntil(
            () => _index.ReadFromItsPluginFileForItsUnreadableSource(_mod.Key), "the binary read in the tree's place");

        Assert.Equal("FixtureNpc", _index.DocumentOf(_npc, _mod.Key).EditorId);
        Assert.Empty(_index.Status.Failures);
    }
}
