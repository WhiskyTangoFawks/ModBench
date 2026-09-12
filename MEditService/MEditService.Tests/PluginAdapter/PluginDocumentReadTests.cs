using System.Text.Json;
using MEditService.Core.PluginAdapter;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Tests.PluginAdapter;

/// <summary>ADR-0005 rule 2's document-shaped read verb: the adapter opens the plugin, the codec
/// serializes each record, and what leaves the pair is text under the schema's own table name.</summary>
public sealed class PluginDocumentReadTests
{
    private const string PluginName = "Documents.esp";

    private const string ParseFailureFixture = "SKI_PlasmaAutocannon.esp";

    private const string UnreadablePerk = "0000EF:SKI_PlasmaAutocannon.esp";

    private static readonly IPluginAdapter Adapter = MutagenPluginAdapter.Instance;

    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    [Fact]
    public void OpenDocuments_YieldsEachRecordAsTheCodecsOwnText_UnderItsSchemaTableName()
    {
        using var data = new PluginFixtureBuilder("documents-read")
            .WithPlugin(PluginName, mod => mod.Npcs.AddNew("DocumentNpc"))
            .Build();
        var path = Path.Combine(data.DataFolder, PluginName);

        using var documents = Adapter.OpenDocuments(
            new ModPath(ModKey.FromFileName(PluginName), path), GameRelease.Fallout4, Schemas);
        var npc = documents.Records.Single(d => d.RecordType == "npc_");

        using var loaded = MutagenPluginAdapter.OpenForRead(new ModPath(ModKey.FromFileName(PluginName), path), GameRelease.Fallout4);
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var expected = codec.SerializeToText(loaded.Getter.EnumerateMajorRecords().Single(), GameRelease.Fallout4);

        Assert.Equal(expected, npc.Text);
        Assert.Equal(loaded.Getter.EnumerateMajorRecords().Single().FormKey.ToString(), npc.FormKey);
        Assert.Null(npc.ParseDiagnosis);
    }

    [Fact]
    public void OpenDocuments_YieldsThePluginHeaderAsTheWholeModDoorsRootDocument()
    {
        using var data = new PluginFixtureBuilder("documents-header")
            .WithPlugin(PluginName, mod => mod.Npcs.AddNew("DocumentNpc"))
            .Build();
        var path = Path.Combine(data.DataFolder, PluginName);

        using var documents = Adapter.OpenDocuments(
            new ModPath(ModKey.FromFileName(PluginName), path), GameRelease.Fallout4, Schemas);

        Assert.Equal(PluginHeader.RecordType, documents.Header.RecordType);
        Assert.Equal($"000000:{PluginName}", documents.Header.FormKey);
        Assert.Contains("ModHeader", documents.Header.Text, StringComparison.Ordinal);
        Assert.DoesNotContain(documents.Records, d => d.RecordType == PluginHeader.RecordType);
    }

    // ADR-0005 rule 5: a record the codec cannot read is indexed read-only with its diagnosis,
    // never dropped, so the diagnosis has to leave the codec/adapter pair beside the record.
    [Fact]
    public void OpenDocuments_YieldsARecordTheCodecCannotRead_AsItsIdentityAndItsDiagnosis()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "TestData", ParseFailureFixture);

        using var documents = Adapter.OpenDocuments(
            new ModPath(ModKey.FromFileName(ParseFailureFixture), path), GameRelease.Fallout4, Schemas);
        var perks = documents.Records.Where(d => d.RecordType == "perk").ToList();

        var unreadable = perks.Single(d => d.FormKey == UnreadablePerk);
        Assert.NotNull(unreadable.ParseDiagnosis);
        Assert.Contains("did not have expected parameter type flag", unreadable.ParseDiagnosis);

        using var stub = JsonDocument.Parse(unreadable.Text);
        Assert.Equal(
            ["FormKey", "EditorID"],
            stub.RootElement.EnumerateObject().Select(p => p.Name).ToList());

        Assert.All(perks.Where(d => d.FormKey != UnreadablePerk), d => Assert.Null(d.ParseDiagnosis));
    }

    [Fact]
    public void OpenDocuments_GivesACellTheBlockCoordinatesItsGrupHierarchyPutsItAt()
    {
        using var data = CellFixture("documents-cell", out var extCellFormKey);
        var path = Path.Combine(data.DataFolder, PluginName);

        using var documents = Adapter.OpenDocuments(
            new ModPath(ModKey.FromFileName(PluginName), path), GameRelease.Fallout4, Schemas);
        var cell = documents.Records.Single(d => d.RecordType == "cell" && d.FormKey == extCellFormKey);

        Assert.Equal(new CellStructure("000800:Documents.esp", 3, 4, 1, 2, IsInterior: false), cell.Cell);
    }

    // ADR-0005: the two placement groups are the GRUP's answer, not the codec's, so they travel
    // beside a cell's document rather than only inside it.
    [Fact]
    public void OpenDocuments_GivesACellTheRefsItsGrupGroupsHold()
    {
        using var data = CellFixture("documents-contents", out var extCellFormKey);
        var path = Path.Combine(data.DataFolder, PluginName);

        using var documents = Adapter.OpenDocuments(
            new ModPath(ModKey.FromFileName(PluginName), path), GameRelease.Fallout4, Schemas);
        var cell = documents.Records.Single(d => d.RecordType == "cell" && d.FormKey == extCellFormKey);

        Assert.Equal(
            [("000802:Documents.esp", "persistent"), ("000803:Documents.esp", "temporary")],
            cell.Contents!.Select(c => (c.FormKey, c.PlacementGroup)).ToList());
    }

    private static PluginFixtureData CellFixture(string prefix, out string extCellFormKey)
    {
        var formKey = string.Empty;
        var data = new PluginFixtureBuilder(prefix)
            .WithPlugin(PluginName, mod =>
            {
                var worldspace = mod.Worldspaces.AddNew("DocumentWorld");
                var cell = new Cell(mod) { EditorID = "DocumentCell" };
                formKey = cell.FormKey.ToString();
                cell.Persistent.Add(new PlacedObject(mod) { EditorID = "kept" });
                cell.Temporary.Add(new PlacedArrow(mod) { EditorID = "arrow" });
                var subBlock = new WorldspaceSubBlock { BlockNumberX = 1, BlockNumberY = 2 };
                subBlock.Items.Add(cell);
                var block = new WorldspaceBlock { BlockNumberX = 3, BlockNumberY = 4 };
                block.Items.Add(subBlock);
                worldspace.SubCells.Add(block);
            })
            .Build();
        extCellFormKey = formKey;
        return data;
    }
}
