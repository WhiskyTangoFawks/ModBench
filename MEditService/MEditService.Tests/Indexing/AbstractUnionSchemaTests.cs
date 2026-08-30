using System.Text.Json;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Indexing;

/// <summary>
/// #548: Mutagen's "A&lt;Name&gt;" abstract Loqui-union convention, generalized beyond #360's own
/// OMOD-only precedent (<c>SchemaReflector.BuildAbstractUnionLeafFields</c>) — a base getter interface
/// with no reflectable ClassType siblings of its own; the real per-subclass data lives on concrete
/// classes that inherit *from* the abstract base rather than the other way OMOD's own leaves do.
///
/// <para><c>Npc.Level</c> (<c>ANpcLevel</c>: <c>NpcLevel</c>/<c>PcLevelMult</c>) and
/// <c>Quest.Aliases</c> (<c>AQuestAlias</c>: <c>QuestReferenceAlias</c>/<c>QuestLocationAlias</c>/
/// <c>QuestCollectionAlias</c>) are this ticket's two mandatory types.
/// <see cref="SchemaReflectorLeafCoverageCompletenessTests"/>'s own <c>KnownGaps</c> asserts the rest
/// of the inventory this mechanism now also covers as a byproduct.</para>
/// </summary>
public class AbstractUnionSchemaTests
{
    private readonly SchemaReflector _reflector = SharedSchemaReflector.Instance;

    // ── Npc.Level (ANpcLevel: NpcLevel / PcLevelMult) ───────────────────────────

    [Fact]
    public void GetSchemas_Npc_LevelColumn_IsNoLongerEmpty()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var level = schemas["npc_"].RecordColumns.SingleOrDefault(c => c.Name == "level");

        Assert.NotNull(level);
        Assert.Equal("struct", level!.ApiType);
    }

    [Fact]
    public void GetSchemas_Npc_LevelColumn_ExtractsNpcLevelShape()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Npc548Level.esp"), Fallout4Release.Fallout4);
        var npc = new Npc(mod.GetNextFormKey("Npc548Level"), Fallout4Release.Fallout4) { EditorID = "Npc548Level" };
        npc.Level = new NpcLevel { Level = 12 };

        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var level = schemas["npc_"].RecordColumns.Single(c => c.Name == "level");
        var element = ExtractObject(level, npc);

        Assert.Equal(12, element["level"].GetInt32());
        Assert.Equal("NpcLevel", element["concrete_type"].GetString());
        Assert.Equal(JsonValueKind.Null, element["level_mult"].ValueKind);
    }

    [Fact]
    public void GetSchemas_Npc_LevelColumn_ExtractsPcLevelMultShape()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Npc548LevelMult.esp"), Fallout4Release.Fallout4);
        var npc = new Npc(mod.GetNextFormKey("Npc548LevelMult"), Fallout4Release.Fallout4) { EditorID = "Npc548LevelMult" };
        npc.Level = new PcLevelMult { LevelMult = 2.5f };

        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var level = schemas["npc_"].RecordColumns.Single(c => c.Name == "level");
        var element = ExtractObject(level, npc);

        Assert.Equal(2.5f, element["level_mult"].GetSingle());
        Assert.Equal("PcLevelMult", element["concrete_type"].GetString());
        Assert.Equal(JsonValueKind.Null, element["level"].ValueKind);
    }

    // ── Quest.Aliases (AQuestAlias: QuestReferenceAlias / QuestLocationAlias / QuestCollectionAlias) ──

    [Fact]
    public void GetSchemas_Quest_AliasesColumn_ElementIsNoLongerEmpty()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var aliases = schemas["qust"].RecordColumns.SingleOrDefault(c => c.Name == "aliases");

        Assert.NotNull(aliases);
        Assert.Equal("array", aliases!.ApiType);
        Assert.NotNull(aliases.ElementType);
        Assert.NotEmpty(aliases.ElementType!.Fields!);
    }

    [Fact]
    public void GetSchemas_Quest_AliasesElement_ExtractsQuestReferenceAliasShape()
    {
        // #548's own acceptance bar: xEdit's "Fill Type" for a Reference Alias is itself several
        // nested structs (Location Alias Reference, External Alias Reference, ...) — QuestReferenceAlias's
        // own Location member is one of them (LocationAliasReference: AliasID/Keyword/RefType).
        var mod = new Fallout4Mod(ModKey.FromFileName("Quest548Ref.esp"), Fallout4Release.Fallout4);
        var quest = new Quest(mod.GetNextFormKey("Quest548Ref"), Fallout4Release.Fallout4) { EditorID = "Quest548Ref" };
        var alias = new QuestReferenceAlias
        {
            Name = "RefAlias",
            AliasIDToForceIntoWhenFilled = 3,
            ClosestToAlias = 7,
            Location = new LocationAliasReference { AliasID = 5 },
        };
        quest.Aliases = [alias];

        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var aliases = schemas["qust"].RecordColumns.Single(c => c.Name == "aliases");
        var element = ExtractFirstArrayElement(aliases, quest);

        Assert.Equal("QuestReferenceAlias", element["concrete_type"].GetString());
        Assert.Equal("RefAlias", element["name"].GetString());
        Assert.Equal(3, element["alias_idto_force_into_when_filled"].GetInt32());
        Assert.Equal(7, element["closest_to_alias"].GetInt32());
        Assert.Equal(JsonValueKind.Object, element["location"].ValueKind);
        Assert.Equal(5, element["location"].GetProperty("alias_id").GetInt32());
    }

    [Fact]
    public void GetSchemas_Quest_AliasesElement_ExtractsQuestLocationAliasShape()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Quest548Loc.esp"), Fallout4Release.Fallout4);
        var quest = new Quest(mod.GetNextFormKey("Quest548Loc"), Fallout4Release.Fallout4) { EditorID = "Quest548Loc" };
        var alias = new QuestLocationAlias { Name = "LocAlias", ClosestToAlias = 9 };
        quest.Aliases = [alias];

        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var aliases = schemas["qust"].RecordColumns.Single(c => c.Name == "aliases");
        var element = ExtractFirstArrayElement(aliases, quest);

        Assert.Equal("QuestLocationAlias", element["concrete_type"].GetString());
        Assert.Equal("LocAlias", element["name"].GetString());
        Assert.Equal(9, element["closest_to_alias"].GetInt32());
        // QuestReferenceAlias-only member — must read null off a QuestLocationAlias element, never
        // a value belonging to a different leaf entirely.
        Assert.Equal(JsonValueKind.Null, element["location"].ValueKind);
    }

    [Fact]
    public void GetSchemas_Quest_AliasesElement_ExtractsQuestCollectionAliasShape()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName("Quest548Coll.esp"), Fallout4Release.Fallout4);
        var quest = new Quest(mod.GetNextFormKey("Quest548Coll"), Fallout4Release.Fallout4) { EditorID = "Quest548Coll" };
        quest.Aliases = [new QuestCollectionAlias()];

        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var aliases = schemas["qust"].RecordColumns.Single(c => c.Name == "aliases");
        var element = ExtractFirstArrayElement(aliases, quest);

        Assert.Equal("QuestCollectionAlias", element["concrete_type"].GetString());
        Assert.Equal(JsonValueKind.Null, element["name"].ValueKind);
    }

    private static Dictionary<string, JsonElement> ExtractObject(ColumnSpec column, IMajorRecordGetter record)
    {
        var json = column.Extract(record) as string;
        Assert.NotNull(json);
        var obj = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json);
        Assert.NotNull(obj);
        return obj;
    }

    private static Dictionary<string, JsonElement> ExtractFirstArrayElement(ColumnSpec column, IMajorRecordGetter record)
    {
        var json = column.Extract(record) as string;
        Assert.NotNull(json);
        var items = JsonSerializer.Deserialize<List<Dictionary<string, JsonElement>>>(json);
        Assert.NotNull(items);
        return Assert.Single(items);
    }
}
