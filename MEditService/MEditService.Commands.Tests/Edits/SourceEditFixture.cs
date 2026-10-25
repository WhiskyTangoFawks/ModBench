using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

/// <summary>The write side as ADR-0015 has it: a temporary compiled plugin tree, a load order
/// value, the codec and the schema. No index and no factory anywhere in it.</summary>
public sealed class SourceEditFixture : TestInstance, ICompiledPlugin
{
    public const string ModFolderOrigin = "FixtureMod";
    public const string PluginName = "Fixture.esp";
    public const string NpcEditorId = "FixtureNpc";
    public const string RaceEditorId = "FixtureRace";
    public const string KeywordEditorId = "FixtureKeyword";
    public const string OtherNpcEditorId = "UntouchedNpc";

    public string ModFolder => FolderOf(ModFolderOrigin);
    public PluginAddress Plugin { get; }
    public string ActualPluginName { get; }

    // Keyword is a valid target for the NPC's keywords field and Race a resolvable target of the
    // wrong type, so both FormLink error axes are reachable without inventing data mid-test.
    public FormKey Npc { get; }
    public FormKey Race { get; }
    public FormKey Keyword { get; }
    public FormKey OtherNpc { get; }
    public FormKey Cell { get; }
    public FormKey Quest { get; }

    private SourceEditFixture(bool isSourceMod, string pluginName, bool isLight)
    {
        ActualPluginName = pluginName;
        var mod = new Fallout4Mod(ModKey.FromFileName(pluginName), Fallout4Release.Fallout4)
        {
            IsSmallMaster = isLight
        };
        var race = mod.Races.AddNew(RaceEditorId);
        var keyword = mod.Keywords.AddNew(KeywordEditorId);
        var npc = mod.Npcs.AddNew(NpcEditorId);
        npc.Race.SetTo(race);
        var otherNpc = mod.Npcs.AddNew(OtherNpcEditorId);
        (Npc, Race, Keyword, OtherNpc) = (npc.FormKey, race.FormKey, keyword.FormKey, otherNpc.FormKey);

        mod.Worldspaces.Add(new Worldspace(mod) { EditorID = "FixtureWorld" });
        var cell = new Cell(mod) { EditorID = "FixtureCell" };
        mod.AddInteriorCells(cell);
        var quest = new Quest(mod) { EditorID = "FixtureQuest" };
        mod.Quests.Add(quest);
        (Cell, Quest) = (cell.FormKey, quest.FormKey);

        // A compiled plugin through the real service: what an edit does to a git working tree is the thing
        // under test, and no mock can answer that.
        Plugin = Add(mod, ModFolderOrigin, isSourceMod);
    }

    public static SourceEditFixture CompiledPlugin() => new(isSourceMod: true, PluginName, isLight: false);

    public static SourceEditFixture CompiledPluginLight(string pluginName = PluginName) =>
        new(isSourceMod: true, pluginName, isLight: true);

    public static SourceEditFixture NonCompiledPlugin() => new(isSourceMod: false, PluginName, isLight: false);

    public ISourceRepository? Repository => RepositoryOf(Plugin);

    public RecordIdentity NpcIdentity => new(Npc.ToString(), "npc_", NpcEditorId);
}
