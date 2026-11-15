using System.Text.Json.Nodes;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.RecordIndex.Queries;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.RepositoriesLib;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda.Plugins;

namespace MEditService.RecordIndex.Tests.Records;

public sealed class WriteNamingItsFilesTests : IDisposable
{
    private const string NewFormKey = $"000F20:{ContainerMod.PluginName}";

    private static readonly string[] Relations =
    [
        "SELECT * FROM mirror.records", "SELECT * FROM mirror.form_references", "SELECT * FROM mirror.holdings",
        "SELECT * FROM mirror.cell_location", "SELECT * FROM winners",
    ];

    private readonly ContainerMod _mod = new();
    private readonly ScratchDirectory _instances = new("medit-write-naming-its-files-");
    private readonly CountingTreeSource _source = new(TestAdapters.Source());
    private readonly OpenedIndex _index;

    public WriteNamingItsFilesTests() =>
        _index = Indexes.Reconciled(_mod.DataFolder, [_mod.Entry], Instance("written"), source: _source);

    public void Dispose()
    {
        _index.Dispose();
        _instances.Dispose();
        _mod.Dispose();
    }

    private string Instance(string name) => Directory.CreateDirectory(Path.Combine(_instances, name)).FullName;

    private ISourceRepository Repository => SourceMods.RepositoryOf(_mod.Entry);

    private RecordDetail Record(FormKey record) => _index.DocumentOf(record.ToString(), _mod.Plugin);

    private RecordIdentity Identity(FormKey record)
    {
        var held = Record(record);
        return new RecordIdentity(held.FormKey, held.RecordType, held.EditorId);
    }

    private SourceDocument Renamed(FormKey record, string editorId)
    {
        var held = Record(record);
        return new SourceDocument(
            held.FormKey, held.RecordType, editorId,
            _mod.Entry.SourceTextOf(held).Replace($"\"{held.EditorId}\"", $"\"{editorId}\"", StringComparison.Ordinal));
    }

    private SourceDocument Copied(FormKey record, string editorId, Action<JsonObject>? shape = null)
    {
        var held = Record(record);
        var text = _mod.Entry.SourceTextOf(held)
            .Replace(held.FormKey, NewFormKey, StringComparison.Ordinal)
            .Replace($"\"{held.EditorId}\"", $"\"{editorId}\"", StringComparison.Ordinal);
        if (shape is not null)
        {
            var document = JsonNode.Parse(text).Require().AsObject();
            shape(document);
            text = document.ToJsonString();
        }
        return new SourceDocument(NewFormKey, held.RecordType, editorId, text);
    }

    private void Written(Answer<SourceChanges, SourceFailure> changes)
    {
        var (moves, deletions, documents) = changes.Value().Under(Repository.SourceFolder);
        EditSaving.Save(moves.Select(move => (move.From, move.To)), deletions, documents.Select(document => (document.Path, document.Text)));
        _index.Holder.SourceWritten(
        [
            new PluginWritten(_mod.Plugin, [.. moves.SelectMany(move => new[] { move.From, move.To }), .. deletions, .. documents.Select(document => document.Path)]),
        ]);
        _ = _index.ListedIn(_mod.Plugin);
        _index.Settled();
    }

    private void AssertTheRowsAFreshReadHolds()
    {
        var fresh = Instance("fresh");
        using (Indexes.Reconciled(_mod.DataFolder, [_mod.Entry], fresh))
        {
            foreach (var relation in Relations)
                Assert.Equal(IndexFiles.Rows(fresh, relation), IndexFiles.Rows(Instance("written"), relation));
        }
    }

    public static TheoryData<string> Writes() =>
    [
        "a record created", "a record deleted", "a record renamed", "an interior cell created", "a cell and its references deleted",
        "a reference put in a cell", "an exterior cell created",
    ];

    private Answer<SourceChanges, SourceFailure> ChangesOf(string write) => write switch
    {
        "a record created" => Repository.ChangesToPut(_mod.Plugin, Copied(_mod.Npc, "CreatedNpc")),
        "a record deleted" => Repository.ChangesToRemove(_mod.Plugin, Identity(_mod.Npc)),
        "a record renamed" => Repository.ChangesToPut(_mod.Plugin, Renamed(_mod.Npc, "RenamedNpc")),
        "an interior cell created" => Repository.ChangesToPut(_mod.Plugin, Copied(_mod.Cell, "CreatedCell")),
        "a cell and its references deleted" => Repository.ChangesToRemove(_mod.Plugin, Identity(_mod.EmbedCell)),
        "a reference put in a cell" => Repository.ChangesToPutChild(_mod.Plugin, Identity(_mod.EmbedCell), "Temporary", Copied(_mod.TemporaryRef, "PutRef")),
        "an exterior cell created" => Repository.ChangesToPutInWorldspace(
            _mod.Plugin, Copied(_mod.Cell, "ExteriorCell", cell => cell["Grid"] = new JsonObject { ["Point"] = "3, 4" }), _mod.Worldspace.ToString()),
        _ => throw new ArgumentOutOfRangeException(nameof(write), write, null),
    };

    [Theory]
    [MemberData(nameof(Writes))]
    public void AWriteNamingItsFiles_LeavesTheRowsAFreshReadOfTheTreeHolds(string write)
    {
        Written(ChangesOf(write));

        AssertTheRowsAFreshReadHolds();
    }

    [Theory]
    [MemberData(nameof(Writes))]
    public void AWriteNamingItsFiles_ReadsNoWholeTree_AndAsksGitOfNoWholeTree(string write)
    {
        var changes = ChangesOf(write);
        var (reads, asked) = (_source.WholeTreeReads, _source.GitStatusAsked);

        Written(changes);

        Assert.Equal((reads, asked), (_source.WholeTreeReads, _source.GitStatusAsked));
    }

    [Fact]
    public void AWriteToARecordAnEarlierWriteMoved_LeavesTheRowsAFreshReadOfTheTreeHolds()
    {
        Written(Repository.ChangesToPut(_mod.Plugin, Renamed(_mod.Npc, "RenamedNpc")));

        Written(Repository.ChangesToPut(_mod.Plugin, Renamed(_mod.Npc, "RenamedAgain")));

        AssertTheRowsAFreshReadHolds();
    }

    [Fact]
    public void AWriteNamingItsFiles_LeavesAnotherFilesHandEditForTheNextCheck()
    {
        _mod.Entry.HandEdit(Record(_mod.Cell), $"\"{ContainerModPlugin.CellEditorId}\"", "\"EditedByHand\"");

        Written(Repository.ChangesToPut(_mod.Plugin, Renamed(_mod.Npc, "RenamedNpc")));

        Assert.Equal("RenamedNpc", Record(_mod.Npc).EditorId);
        Assert.Equal(ContainerModPlugin.CellEditorId, Record(_mod.Cell).EditorId);
    }

    [Fact]
    public void ARecordAWriteCreated_IsAdded()
    {
        Written(Repository.ChangesToPut(_mod.Plugin, Copied(_mod.Npc, "CreatedNpc")));

        Assert.Equal(WorkingTreeState.Added, _index.RowOf(NewFormKey, _mod.Plugin)?.WorkingTreeState);
    }

    [Fact]
    public void AWriteNamingTheHeader_ReadsThePluginWhole()
    {
        var header = Directory.GetFiles(
            Path.Combine(_mod.Entry.ModFolderOf(), PluginSourceRoot.For(ContainerMod.PluginName)), "*.json", SearchOption.TopDirectoryOnly).Single();
        var reads = _source.WholeTreeReads;

        _index.Holder.SourceWritten([new PluginWritten(_mod.Plugin, [header])]);
        _ = _index.ListedIn(_mod.Plugin);

        Assert.True(_source.WholeTreeReads > reads);
    }
}
