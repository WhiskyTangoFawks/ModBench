using MEditService.Commands.Tests.TestSupport;
using MEditService.LoadOrder;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

namespace MEditService.Commands.Tests.Edits;

/// <summary>A tracked mod holding the one shape a flat record cannot show: a worldspace, whose
/// directory a FormID edit moves whole, subtree and all. No index anywhere in it.</summary>
public sealed class SourceContainerFixture : TestInstance, ITrackedPlugin
{
    public const string PluginName = "SourceContainer.esp";
    public const string Origin = "SourceContainerMod";
    public const string WorldspaceEditorId = "FixtureWorld";
    public const string TopCellEditorId = "FixtureTopCell";
    public const string TopCellRefEditorId = "FixtureTopCellRef";

    public string ModFolder => FolderOf(Origin);
    public PluginAddress Plugin { get; }
    public FormKey Worldspace { get; }
    public FormKey TopCell { get; }
    public FormKey TopCellRef { get; }

    public SourceContainerFixture()
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        var worldspace = new Worldspace(mod) { EditorID = WorldspaceEditorId };
        var topCell = new Cell(mod) { EditorID = TopCellEditorId, WaterHeight = 5f };
        var topCellRef = new PlacedObject(mod)
        {
            EditorID = TopCellRefEditorId,
            Position = new P3Float(7f, 8f, 9f),
            Scale = 6f,
        };
        topCell.Temporary.Add(topCellRef);
        worldspace.TopCell = topCell;
        mod.Worldspaces.Add(worldspace);
        Plugin = Add(mod, Origin);
        (Worldspace, TopCell, TopCellRef) = (worldspace.FormKey, topCell.FormKey, topCellRef.FormKey);
    }
}
