using System.Text.Json;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Indexing;

/// <summary>Mutagen's "A&lt;Name&gt;" convention: a base getter interface with no reflectable
/// ClassType siblings; the per-subclass data lives on concrete classes inheriting from the base,
/// the reverse of OMOD's own leaves.</summary>
public class AbstractUnionSchemaTests
{
    private readonly SchemaReflector _reflector = SharedSchemaReflector.Instance;

    // ── Npc.Level (ANpcLevel: NpcLevel / PcLevelMult) ───────────────────────────

    [Fact]
    public void GetSchemas_Npc_LevelColumn_IsAStructColumn()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var level = schemas["npc_"].RecordColumns.SingleOrDefault(c => c.Name == "Level");

        Assert.NotNull(level);
        Assert.Equal("struct", level!.ApiType);
    }

    // ── Quest.Aliases (AQuestAlias: QuestReferenceAlias / QuestLocationAlias / QuestCollectionAlias) ──

    [Fact]
    public void GetSchemas_Quest_AliasesColumn_ElementHasFields()
    {
        var schemas = _reflector.GetSchemas(GameRelease.Fallout4);
        var aliases = schemas["qust"].RecordColumns.SingleOrDefault(c => c.Name == "Aliases");

        Assert.NotNull(aliases);
        Assert.Equal("array", aliases!.ApiType);
        Assert.NotNull(aliases.Field.ElementSpec);
        Assert.NotEmpty(aliases.Field.ElementSpec!.SubFields!);
    }


}
