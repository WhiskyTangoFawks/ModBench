using System.Text.Json;
using MEditService.Core.Schema;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.RealData;

/// <summary>
/// #548's own acceptance bar ("a real fixture... matching xEdit's display"), against the committed
/// cut-down Fallout 4 plugin rather than an in-memory-constructed record
/// (<see cref="MEditService.Tests.Indexing.AbstractUnionSchemaTests"/> already covers that half).
/// Read through <see cref="ModFactory.ImportGetter"/> the same way <see cref="CutDownPluginFixture"/>
/// itself does — a real binary-overlay read, not a fully-materialized in-memory object — because that
/// lazy overlay path is where a per-property custom binary translation (Mutagen's own
/// <c>binary="NoGeneration"</c> on <c>PcLevelMult.LevelMult</c>, confirmed against the real generated
/// source) could plausibly diverge from the eager, hand-constructed shape the other test file proves.
/// It does not, empirically: <c>Npc.Level</c> is materialized as a concrete <c>NpcLevel</c>/
/// <c>PcLevelMult</c> object at NPC-parse time regardless of overlay mode (Mutagen's own custom
/// <c>NpcBinaryCreateTranslation</c> constructs it directly off the ACBS flag bit), so its own
/// <c>LevelMult</c> read never reaches <c>PcLevelMultBinaryOverlay</c>'s unimplemented stub. Quest
/// alias elements, by contrast, do stay lazy <c>...BinaryOverlay</c> instances until touched — this
/// file's own <see cref="Aliases_DialogueConcordArea_HasBothReferenceAndLocationAliasKinds"/> is the
/// proof that still works, because <c>BuildAbstractUnionMemberField</c>'s own <c>IsInstanceOfType</c>
/// checks are against each leaf's *getter interface*, which an overlay class implements the same as
/// its eager counterpart.
///
/// <para>The committed fixture (<c>CutDownPluginGenerator</c>'s "first 4 VMAD-bearing records"
/// curation) has no <c>PcLevelMult</c> NPC among its four, and no <c>QuestCollectionAlias</c> among
/// its four quests' aliases — both verified empirically, not assumed, by enumerating every NPC/Quest
/// in the fixture. Regenerating to guarantee one of each would mean changing
/// <c>CutDownPluginGenerator</c>'s own selection criteria, a committed-test-data change reported to
/// the orchestrator rather than made silently.</para>
/// </summary>
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
