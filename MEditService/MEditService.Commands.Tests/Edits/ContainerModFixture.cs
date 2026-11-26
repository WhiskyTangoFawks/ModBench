using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Commands.Tests.Edits;

/// <summary>The container counterpart to SourceEditFixture, which holds only flat records. No
/// index anywhere in it.</summary>
public sealed class ContainerModFixture : TestInstance, ICompiledPlugin
{
    public const string ModFolderOrigin = "ContainerFixtureMod";
    public const string PluginName = "ContainerFixture.esp";

    public string ModFolder => FolderOf(ModFolderOrigin);
    public PluginAddress Plugin { get; }

    public FormKey Npc { get; }

    public FormKey Cell { get; }

    public FormKey EmbedCell { get; }

    public FormKey TemporaryRef { get; }

    public FormKey Worldspace { get; }

    public FormKey ExteriorRef { get; }

    // A quest holding a topic, so it has a directory of its own for a created child to land in.
    public FormKey Quest { get; }

    public ContainerModFixture()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);

        var npc = mod.Npcs.AddNew("FixtureNpc");
        var containerKeys = ContainerModPlugin.AddTo(mod);

        var exteriorCell = new Cell(mod) { EditorID = "ExteriorCell", Grid = new CellGrid() };
        var exteriorRef = new PlacedObject(mod) { EditorID = "ExteriorRef", Position = new P3Float(100f, 100f, 0f), Scale = 1f };
        exteriorCell.Temporary.Add(exteriorRef);
        mod.Worldspaces.AddNew("ExteriorWorld").SubCells.Add(CellBlocks.Exterior(exteriorCell));

        var quest = new Quest(mod) { EditorID = "EmbedQuest" };
        quest.DialogTopics.Add(new DialogTopic(mod) { EditorID = "EmbedTopic" });
        mod.Quests.Add(quest);

        Plugin = Add(mod, ModFolderOrigin);

        Npc = npc.FormKey;
        Cell = containerKeys.Cell;
        (EmbedCell, TemporaryRef, Worldspace) = (containerKeys.EmbedCell, containerKeys.TemporaryRef, containerKeys.Worldspace);
        (ExteriorRef, Quest) = (exteriorRef.FormKey, quest.FormKey);
    }
}
