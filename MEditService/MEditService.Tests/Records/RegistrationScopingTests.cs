using DuckDB.NET.Data;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;

namespace MEditService.Tests.Records;

// #582 / ADR-0001: registration is visibility. An unregistered plugin's rows stay in the index
// (physically, in the `mirror` schema) and answer nothing on any path — every IRecordReads member,
// both refs, and the SQL door (the generated per-type views, `records`, the extracted tables).
// Re-registering makes the same rows answer again with no re-index. This is the gate test the
// ticket names; each read is asserted individually so a regression names the path that leaked.
public class RegistrationScopingTests
{
    private static readonly SchemaReflector Reflector = SharedSchemaReflector.Instance;
    private static readonly TableDdlBuilder Ddl = new TableDdlBuilder(Reflector);

    private static readonly PluginKey AlphaKey = new("Alpha.esp", "ModA");
    private static readonly PluginKey BetaKey = new("Beta.esp", "ModB");

    // Every kind of row the index extracts, so every read path has something to (not) answer with:
    // a Race + an Npc linking it (form_references), a worldspace with one exterior cell holding one
    // placed ref plus one interior cell (placement / cell_location), and a Quest with a DialogTopic
    // (container_child). Beta additionally overrides Alpha's Npc, so the override stack and the
    // contested-FormKey read have a Beta entry to lose.
    private sealed record Fixture(
        DuckDbRecordIndex Repo, string SharedNpcFk, string BetaNpcFk, string BetaRaceFk,
        string BetaWorldspaceFk, string BetaCellFk, string BetaPlacedFk, string BetaQuestFk, string BetaTopicFk,
        int BetaRecordCount) : IDisposable
    {
        public void Dispose() => Repo.Dispose();
    }

    private static (string RaceFk, string NpcFk, string WorldspaceFk, string CellFk, string PlacedFk, string QuestFk, string TopicFk)
        Populate(Fallout4Mod mod, string tag)
    {
        var race = mod.Races.AddNew($"Race{tag}");
        var npc = mod.Npcs.AddNew($"Npc{tag}");
        npc.Race.SetTo(race.FormKey);

        var wrld = mod.Worldspaces.AddNew($"World{tag}");
        var extCell = new Cell(mod) { EditorID = $"Cell{tag}", Grid = new CellGrid { Point = new P2Int(0, 0) } };
        var placed = new PlacedObject(mod) { EditorID = $"Ref{tag}" };
        extCell.Persistent.Add(placed);
        var subBlock = new WorldspaceSubBlock { BlockNumberX = 0, BlockNumberY = 0 };
        subBlock.Items.Add(extCell);
        var block = new WorldspaceBlock { BlockNumberX = 0, BlockNumberY = 0 };
        block.Items.Add(subBlock);
        wrld.SubCells.Add(block);

        var intCell = new Cell(mod) { EditorID = $"Interior{tag}" };
        var intSub = new CellSubBlock { BlockNumber = 0 };
        intSub.Cells.Add(intCell);
        var intBlock = new CellBlock { BlockNumber = 0 };
        intBlock.SubBlocks.Add(intSub);
        mod.Cells.Records.Add(intBlock);

        var quest = mod.Quests.AddNew($"Quest{tag}");
        var topic = new DialogTopic(mod) { EditorID = $"Topic{tag}" };
        quest.DialogTopics.Add(topic);

        return (race.FormKey.ToString(), npc.FormKey.ToString(), wrld.FormKey.ToString(), extCell.FormKey.ToString(),
            placed.FormKey.ToString(), quest.FormKey.ToString(), topic.FormKey.ToString());
    }

    private static Fixture Build()
    {
        var alpha = new Fallout4Mod(ModKey.FromFileName(AlphaKey.Name), Fallout4Release.Fallout4);
        var (_, sharedNpcFk, _, _, _, _, _) = Populate(alpha, "A");

        var beta = new Fallout4Mod(ModKey.FromFileName(BetaKey.Name), Fallout4Release.Fallout4);
        var (betaRace, betaNpc, betaWrld, betaCell, betaPlaced, betaQuest, betaTopic) = Populate(beta, "B");
        beta.ModHeader.MasterReferences.Add(new MasterReference { Master = alpha.ModKey });
        beta.Npcs.Set(alpha.Npcs.Single().DeepCopy());

        var repo = new DuckDbRecordIndex(Reflector, Ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        repo.Index((IModGetter)alpha, Registration.Participating(0), AlphaKey);
        repo.Index((IModGetter)beta, Registration.Participating(1), BetaKey);
        repo.UpdateWinners();

        return new Fixture(repo, sharedNpcFk, betaNpc, betaRace, betaWrld, betaCell, betaPlaced, betaQuest, betaTopic,
            beta.EnumerateMajorRecords().Count());
    }

    private static long Scalar(DuckDbRecordIndex repo, string sql, params object[] args)
    {
        using var cmd = repo.Connection.CreateCommand();
        cmd.CommandText = sql;
        foreach (var arg in args) cmd.Parameters.Add(new DuckDBParameter { Value = arg });
        return Convert.ToInt64(cmd.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture);
    }

    private static long RowsFor(DuckDbRecordIndex repo, string relation, PluginKey key) =>
        Scalar(repo, $"SELECT COUNT(*) FROM {relation} WHERE plugin = $1 AND origin = $2", key.Name, key.Origin!);

    private static IEnumerable<string> GeneratedViews() =>
        Reflector.GetSchemas(GameRelease.Fallout4).Keys
            .Where(t => !string.Equals(t, HeaderIndexer.TableName, StringComparison.OrdinalIgnoreCase));

    [Fact]
    public void Unregister_LeavesRowsInPlace_AndNoReadAnswersForThePlugin()
    {
        using var fx = Build();
        var repo = fx.Repo;

        // Premise: registered, everything answers — otherwise the emptiness below proves nothing.
        Assert.Equal(fx.BetaRecordCount, repo.GetDocuments(BetaKey).Count);
        Assert.Equal(2, repo.GetOverrideStack(fx.SharedNpcFk)!.Entries.Count);
        Assert.NotEmpty(repo.GetReferencedBy(fx.BetaRaceFk));
        Assert.NotNull(repo.GetPlacement(fx.BetaPlacedFk, BetaKey));
        Assert.NotEmpty(repo.GetContainerChildren(BetaKey, fx.BetaQuestFk));

        repo.Unregister(BetaKey);
        repo.UpdateWinners();

        // The rows demonstrably remain — the mirror schema is the one door that sees them.
        Assert.Equal(fx.BetaRecordCount, RowsFor(repo, "mirror.records", BetaKey));
        foreach (var table in new[] { "mirror.form_lookup", "mirror.placement", "mirror.cell_location", "mirror.container_child", "mirror.header" })
            Assert.True(RowsFor(repo, table, BetaKey) > 0, $"{table} should keep Beta's rows");
        Assert.True(Scalar(repo, "SELECT COUNT(*) FROM mirror.form_references WHERE source_plugin = $1 AND source_origin = $2",
            BetaKey.Name, BetaKey.Origin!) > 0);

        // Documents.
        Assert.Null(repo.GetDocument(fx.BetaNpcFk));
        Assert.Null(repo.GetDocument(fx.BetaNpcFk, BetaKey));
        Assert.Empty(repo.GetDocuments(BetaKey));
        Assert.Null(repo.GetOverrideStack(fx.BetaNpcFk));
        var shared = repo.GetOverrideStack(fx.SharedNpcFk)!;
        var only = Assert.Single(shared.Entries);
        Assert.Equal(AlphaKey.Name, only.Plugin.Name);
        Assert.True(only.IsWinner);
        Assert.Equal(AlphaKey.Name, repo.GetDocument(fx.SharedNpcFk)!.Plugin.Name);
        // Head answers through the same scoping, not a second implementation.
        var head = repo.At(RecordRef.Head);
        Assert.Null(head.GetDocument(fx.BetaNpcFk));
        Assert.Empty(head.GetDocuments(BetaKey));
        Assert.Single(head.GetOverrideStack(fx.SharedNpcFk)!.Entries);

        // Listings and counts.
        Assert.Empty(repo.Search(new RecordQuery(Plugin: BetaKey, Limit: 1000)).Items);
        Assert.DoesNotContain(repo.Search(new RecordQuery(Limit: 1000)).Items, r => r.Plugin == BetaKey.Name);
        Assert.Empty(repo.GetRecordTypeCounts(BetaKey));
        Assert.Empty(repo.GetContestedFormKeys());
        Assert.Empty(repo.GetNativeFormKeys(BetaKey));
        Assert.Empty(repo.GetEffectiveMasters(BetaKey));

        // Extracted tables.
        Assert.Null(repo.Resolve(fx.BetaNpcFk));
        Assert.Empty(repo.GetReferencedBy(fx.BetaRaceFk));
        Assert.Empty(repo.GetWorldspaceCells(BetaKey, fx.BetaWorldspaceFk));
        Assert.Empty(repo.GetInteriorCells(BetaKey, 50, 0).Items);
        var cellRefs = repo.GetCellReferences(BetaKey, fx.BetaCellFk);
        Assert.Empty(cellRefs.Persistent);
        Assert.Empty(cellRefs.Temporary);
        Assert.Null(repo.GetPlacement(fx.BetaPlacedFk, BetaKey));
        Assert.Null(repo.GetCellLocation(BetaKey, fx.BetaCellFk));
        Assert.Empty(repo.GetContainerChildren(BetaKey, fx.BetaQuestFk));
        Assert.Null(repo.GetContainerParent(BetaKey, fx.BetaTopicFk));

        // The SQL door: user filter SQL and the filtered-chevron read see nothing of Beta either.
        repo.SetFilter("SELECT form_key FROM npc_");
        Assert.DoesNotContain(BetaKey.Name, repo.GetPluginsWithMatchingRecords(["npc_"]));
        Assert.Contains(AlphaKey.Name, repo.GetPluginsWithMatchingRecords(["npc_"]));
        repo.SetFilter(null);

        // Alpha, still registered, is untouched by its neighbour's unregistration.
        Assert.NotEmpty(repo.GetDocuments(AlphaKey));
        Assert.NotEmpty(repo.GetRecordTypeCounts(AlphaKey));
    }

    [Fact]
    public void Unregister_EveryGeneratedViewAndPublicRelation_AnswersNothingForThePlugin()
    {
        using var fx = Build();
        var repo = fx.Repo;
        repo.Unregister(BetaKey);

        Assert.All(new[] { "records", "records_head", "form_lookup", "placement", "cell_location", "container_child", "header" },
            relation => Assert.Equal(0, RowsFor(repo, relation, BetaKey)));
        Assert.Equal(0, Scalar(repo, "SELECT COUNT(*) FROM form_references WHERE source_plugin = $1 AND source_origin = $2",
            BetaKey.Name, BetaKey.Origin!));

        var viewsWithBetaRows = GeneratedViews()
            .Where(view => RowsFor(repo, $"\"{view}\"", BetaKey) > 0)
            .ToList();
        Assert.Empty(viewsWithBetaRows);
        // ...while the same views still carry Alpha, so an empty schema could not pass this vacuously.
        Assert.True(RowsFor(repo, "\"npc_\"", AlphaKey) > 0);
    }

    [Fact]
    public void Register_AfterUnregister_AnswersAgainWithoutReindex()
    {
        using var fx = Build();
        var repo = fx.Repo;
        repo.Unregister(BetaKey);
        repo.UpdateWinners();
        Assert.Empty(repo.GetDocuments(BetaKey));

        repo.Register(BetaKey, Registration.Participating(1));
        repo.UpdateWinners();

        Assert.Equal(fx.BetaRecordCount, repo.GetDocuments(BetaKey).Count);
        var stack = repo.GetOverrideStack(fx.SharedNpcFk)!.Entries;
        Assert.Equal(2, stack.Count);
        Assert.True(stack.Single(e => e.Plugin.Name == BetaKey.Name).IsWinner);
        Assert.Equal(BetaKey.Name, repo.GetDocument(fx.SharedNpcFk)!.Plugin.Name);
        Assert.NotNull(repo.Resolve(fx.BetaNpcFk));
        Assert.NotNull(repo.GetPlacement(fx.BetaPlacedFk, BetaKey));
        Assert.NotEmpty(repo.GetContainerChildren(BetaKey, fx.BetaQuestFk));
        Assert.True(RowsFor(repo, "\"npc_\"", BetaKey) > 0);
        Assert.Contains(fx.SharedNpcFk, repo.GetContestedFormKeys());
    }

    // Unindex is the file-gone verb: the inverse of Index, rows and registration alike.
    [Fact]
    public void Unindex_RemovesTheRowsThemselves()
    {
        using var fx = Build();
        var repo = fx.Repo;

        repo.Unindex(BetaKey);

        Assert.Equal(0, RowsFor(repo, "mirror.records", BetaKey));
        Assert.Equal(0, Scalar(repo, "SELECT COUNT(*) FROM registrations WHERE plugin = $1 AND origin = $2", BetaKey.Name, BetaKey.Origin!));
    }
}
