using DuckDB.NET.Data;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Indexing;

/// <summary>
/// The five <c>ContainerChildFields</c> relationships <c>placement</c>/<c>cell_location</c>
/// don't already carry — Cell.NavigationMeshes/Landscape, Quest.DialogBranches/DialogTopics,
/// DialogTopic.Responses — land in <c>container_child</c> at ingest, in original slot order, and
/// Cell.Persistent/Temporary/Worldspace.TopCell/SubCells (already covered by placement/cell_location)
/// do NOT get a second, competing copy there.
/// </summary>
public sealed class ContainerChildIndexingTests
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private sealed record Built(
        DuckDbRecordIndex Repo, string QuestFk, string Topic0Fk, string Topic1Fk,
        string Response0Fk, string Response1Fk, string CellFk, string NavMesh0Fk, string LandscapeFk) : IDisposable
    {
        public void Dispose() => Repo.Dispose();
    }

    private static Built IndexFixture()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Dialogue.esp"), Fallout4Release.Fallout4);

        var quest = mod.Quests.AddNew("TestQuest");
        var topic0 = new DialogTopic(mod) { EditorID = "Topic0" };
        var response0 = new DialogResponses(mod) { EditorID = "Response0" };
        var response1 = new DialogResponses(mod) { EditorID = "Response1" };
        topic0.Responses.Add(response0);
        topic0.Responses.Add(response1);
        var topic1 = new DialogTopic(mod) { EditorID = "Topic1" };
        quest.DialogTopics.Add(topic0);
        quest.DialogTopics.Add(topic1);

        var cell = new Cell(mod) { EditorID = "NavCell" };
        var navMesh0 = new NavigationMesh(mod);
        cell.NavigationMeshes.Add(navMesh0);
        var landscape = new Landscape(mod);
        cell.Landscape = landscape;
        var intSub = new CellSubBlock { BlockNumber = 0 };
        intSub.Cells.Add(cell);
        var intBlock = new CellBlock { BlockNumber = 0 };
        intBlock.SubBlocks.Add(intSub);
        mod.Cells.Records.Add(intBlock);

        var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        repo.Index((IModGetter)mod, Registration.Participating(0), new PluginKey(mod.ModKey.FileName.ToString(), "Data"));
        repo.UpdateWinners();

        return new Built(
            repo, quest.FormKey.ToString(), topic0.FormKey.ToString(), topic1.FormKey.ToString(),
            response0.FormKey.ToString(), response1.FormKey.ToString(), cell.FormKey.ToString(),
            navMesh0.FormKey.ToString(), landscape.FormKey.ToString());
    }

    private static List<(string ChildFormKey, string SlotName, int SlotIndex)> QueryChildren(
        DuckDbRecordIndex repo, string parentFormKey)
    {
        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = """
            SELECT child_form_key, slot_name, slot_index FROM container_child
            WHERE parent_form_key = $1 ORDER BY slot_name, slot_index
            """;
        cmd.Parameters.Add(new DuckDBParameter { Value = parentFormKey });
        using var reader = cmd.ExecuteReader();
        var rows = new List<(string, string, int)>();
        while (reader.Read())
            rows.Add((reader.GetString(0), reader.GetString(1), reader.GetInt32(2)));
        return rows;
    }

    [Fact]
    public void Index_PopulatesQuestDialogTopics_InOriginalOrder()
    {
        using var built = IndexFixture();
        var rows = QueryChildren(built.Repo, built.QuestFk)
            .Where(r => r.SlotName == "DialogTopics").ToList();

        Assert.Equal([(built.Topic0Fk, "DialogTopics", 0), (built.Topic1Fk, "DialogTopics", 1)], rows);
    }

    [Fact]
    public void Index_PopulatesDialogTopicResponses_InOriginalOrder()
    {
        using var built = IndexFixture();
        var rows = QueryChildren(built.Repo, built.Topic0Fk);

        Assert.Equal(
            [(built.Response0Fk, "Responses", 0), (built.Response1Fk, "Responses", 1)],
            rows);
    }

    [Fact]
    public void Index_PopulatesCellNavigationMeshesAndLandscape()
    {
        using var built = IndexFixture();
        var rows = QueryChildren(built.Repo, built.CellFk);

        Assert.Contains((built.NavMesh0Fk, "NavigationMeshes", 0), rows);
        Assert.Contains((built.LandscapeFk, "Landscape", 0), rows);
    }

    // placement/cell_location already cover
    // Persistent/Temporary/TopCell/SubCells, so container_child must never carry a second, competing
    // copy of those slots — a naive "index every ContainerChildFields relationship" implementation
    // would fail this.
    [Fact]
    public void Index_DoesNotDuplicate_RelationshipsAlreadyCoveredByPlacementTables()
    {
        using var built = IndexFixture();

        using var cmd = built.Repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM container_child WHERE slot_name IN ('Persistent', 'Temporary', 'TopCell', 'SubCells')";
        var count = (long)cmd.ExecuteScalar()!;

        Assert.Equal(0, count);
    }

    [Fact]
    public void Unindex_RemovesContainerChildRows()
    {
        using var built = IndexFixture();
        built.Repo.Unindex(new PluginKey("Dialogue.esp", "Data"));

        using var cmd = built.Repo.Connection.CreateCommand();
        cmd.CommandText = "SELECT COUNT(*) FROM container_child";
        var count = (long)cmd.ExecuteScalar()!;

        Assert.Equal(0, count);
    }
}
