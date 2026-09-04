using System.Text.Json;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.RealData;

/// <summary>Read through the lazy binary overlay, where a per-property custom translation could diverge
/// from the eager shape.</summary>
public sealed class AbstractUnionRealDataTests
{
    private static readonly IReadOnlyDictionary<string, RecordTableSchema> Schemas =
        SharedSchemaReflector.Instance.GetSchemas(GameRelease.Fallout4);

    private static IModDisposeGetter OpenFixture() =>
        ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(CutDownPluginFixture.PluginFileName), CutDownPluginFixture.PluginPath),
            GameRelease.Fallout4);

    [Fact]
    public void Level_EveryFixtureNpc_ExtractsANonNullConcreteTypeDiscriminator()
    {
        var level = Schemas["npc_"].RecordColumns.Single(c => c.Name == "level");

        using var overlay = OpenFixture();
        var npcs = ((IFallout4ModGetter)overlay).Npcs.ToList();
        Assert.NotEmpty(npcs);
        foreach (var npc in npcs)
        {
            var json = level.Extract(npc) as string;
            Assert.NotNull(json);
            var element = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json!)!;
            // Every real fixture NPC is NpcLevel today (verified — none is PcLevelMult), so this
            // pins the discriminator reads correctly through a real binary-overlay-backed NPC without
            // depending on the one shape the fixture happens not to have.
            Assert.Equal("NpcLevel", element["concrete_type"].GetString());
            Assert.True(element["level"].GetInt32() >= 0);
        }
    }

    [Fact]
    public void Aliases_DialogueConcordArea_HasBothReferenceAndLocationAliasKinds()
    {
        var aliases = Schemas["qust"].RecordColumns.Single(c => c.Name == "aliases");
        using var overlay = OpenFixture();
        var quest = ((IFallout4ModGetter)overlay).Quests.Single(q => q.EditorID == "DialogueConcordArea");

        var json = aliases.Extract(quest) as string;
        Assert.NotNull(json);
        var elements = JsonSerializer.Deserialize<List<Dictionary<string, JsonElement>>>(json!)!;
        Assert.NotEmpty(elements);

        var kinds = elements.Select(e => e["concrete_type"].GetString()).ToHashSet();
        Assert.Contains("QuestReferenceAlias", kinds);
        Assert.Contains("QuestLocationAlias", kinds);

        // Every element's own discriminator names a real leaf — never null (an unrecognized runtime
        // type would silently read every field null, which this rules out for the whole fixture
        // quest, not just its first alias).
        Assert.All(elements, e => Assert.False(string.IsNullOrEmpty(e["concrete_type"].GetString())));
    }
}
